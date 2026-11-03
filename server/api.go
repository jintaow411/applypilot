package main

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

const maxBodyBytes = 32 << 20 // 32 MiB: full HTML + CSS blobs

var validStatuses = map[string]bool{"new": true, "wip": true, "done": true}

type api struct {
	store *Store
}

func newRouter(store *Store, token string, allowedOrigins map[string]struct{}) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)

	r := gin.New()
	r.Use(gin.Recovery(), corsMiddleware(allowedOrigins))

	a := &api{store: store}

	r.GET("/healthz", a.health)

	// Every API route can expose or modify locally stored application data.
	// Keep the health probe public, but require the pairing token everywhere else.
	grp := r.Group("/api", requireToken(token))
	grp.GET("/schema", a.getSchema)
	grp.PUT("/sites/:domain/schema", a.putSchema)
	grp.POST("/reports", a.postReport)
	grp.GET("/reports", a.listReports)
	grp.GET("/reports/:id", a.getReport)
	grp.PATCH("/reports/:id", a.patchReport)
	grp.POST("/fills", a.postFill)
	grp.POST("/logs", a.postLog)
	grp.GET("/logs", a.listLogs)
	grp.GET("/stats", a.getStats)

	r.NoRoute(func(c *gin.Context) {
		fail(c, http.StatusNotFound, "not_found", "接口不存在：请检查 method+path 是否拼对（如 GET /healthz、GET /api/stats）后重试。")
	})
	return r
}

// corsMiddleware accepts same-machine command-line clients (which have no
// Origin) and the explicitly configured extension origins only. A prefix
// check is insufficient: any installed extension can otherwise read a
// loopback service once the browser grants it localhost access.
func corsMiddleware(allowedOrigins map[string]struct{}) gin.HandlerFunc {
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" {
			if _, ok := allowedOrigins[origin]; !ok {
				fail(c, http.StatusForbidden, "forbidden", "来源不被允许：仅支持无 Origin 的本地请求或已配置的扩展来源，请检查 AUTO_INFO_EXTENSION_ORIGIN 后重试。")
				c.Abort()
				return
			}
			h := c.Writer.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			h.Set("Access-Control-Max-Age", "600")
		}
		if c.Request.Method == http.MethodOptions {
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	}
}

// requireToken guards write-back with `Authorization: Bearer $TOKEN`.
func requireToken(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		scheme, value, ok := strings.Cut(strings.TrimSpace(c.GetHeader("Authorization")), " ")
		if !ok || !strings.EqualFold(scheme, "Bearer") {
			c.Header("WWW-Authenticate", "Bearer")
			fail(c, http.StatusUnauthorized, "unauthorized", "身份校验失败：缺少或格式错误的 Authorization 头（应为 Bearer <token>）。请去扩展侧边栏配对页重贴服务端 token 后重试。")
			c.Abort()
			return
		}
		value = strings.TrimSpace(value)
		if subtle.ConstantTimeCompare([]byte(value), []byte(token)) != 1 {
			c.Header("WWW-Authenticate", "Bearer")
			fail(c, http.StatusUnauthorized, "unauthorized", "身份校验失败：token 不对。请去扩展侧边栏配对页重贴服务端打印的 token 后重试。")
			c.Abort()
			return
		}
		c.Next()
	}
}

func (a *api) health(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": appVersion})
}

func (a *api) getSchema(c *gin.Context) {
	domain := normalizeDomain(c.Query("domain"))
	if domain == "" {
		fail(c, http.StatusBadRequest, "bad_request", "缺少 domain 参数：请在 query 里带上 domain=xxx（如 /api/schema?domain=example.com）。")
		return
	}

	adapter, version, found, err := a.store.GetSite(domain)
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：查询站点配置时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	// mode is authoritative: only an exact DB hit is "site", everything else
	// is "generic". The frontend must not infer site from a non-empty adapter.
	if !found {
		c.JSON(http.StatusOK, gin.H{"found": false, "adapter": nil, "version": 0, "mode": "generic"})
		return
	}
	if !isJSONObject(adapter) {
		adapter = json.RawMessage("{}")
	}
	c.JSON(http.StatusOK, gin.H{"found": true, "adapter": json.RawMessage(adapter), "version": version, "mode": "site"})
}

func (a *api) putSchema(c *gin.Context) {
	domain := normalizeDomain(c.Param("domain"))
	if domain == "" {
		fail(c, http.StatusBadRequest, "bad_request", "路径里的 domain 为空或非法：请用 PUT /api/sites/<域名>/schema，域名如 example.com。")
		return
	}

	var req struct {
		Adapter json.RawMessage `json:"adapter"`
		Version *int            `json:"version"`
	}
	if !decodeBody(c, &req) {
		return
	}
	if !isJSONObject(req.Adapter) {
		fail(c, http.StatusBadRequest, "bad_request", "adapter 非法：必须是 JSON 对象，不能是字符串、数组或空值，请修正后重试。")
		return
	}

	version := 1
	if req.Version != nil && *req.Version > 0 {
		version = *req.Version
	}
	if err := a.store.UpsertSite(domain, string(req.Adapter), version); err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：保存站点配置时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "domain": domain, "version": version})
}

func (a *api) postReport(c *gin.Context) {
	var req struct {
		Domain string          `json:"domain"`
		URL    string          `json:"url"`
		Title  string          `json:"title"`
		HTML   string          `json:"html"`
		CSS    string          `json:"css"`
		JSMeta json.RawMessage `json:"jsMeta"`
		Schema json.RawMessage `json:"schema"`
		// note belongs to the shared ReportPayload contract, but the frozen
		// three-table schema has no note column, so it is accepted and not
		// persisted (and must not be merged into schema_json, which is
		// contract-bound by shared/page-schema.schema.json).
		Note string `json:"note"`
	}
	if !decodeBody(c, &req) {
		return
	}

	domain := normalizeDomain(req.Domain)
	pageURL := normalizeReportURL(req.URL)
	if domain == "" || pageURL == "" {
		fail(c, http.StatusBadRequest, "bad_request", "缺少 domain 或 url：上报页面时两者必填（如 domain=example.com，url=https://example.com/xxx），请补齐后重试。")
		return
	}

	jsMeta := jsonBlob(req.JSMeta, "{}")
	schemaJSON := jsonBlob(req.Schema, "{}")

	id, updated, err := a.store.UpsertReport(Report{
		Domain:     domain,
		URL:        pageURL,
		Title:      req.Title,
		HTML:       req.HTML,
		CSS:        req.CSS,
		JSMeta:     jsMeta,
		SchemaJSON: schemaJSON,
		Status:     "new",
	})
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：保存页面上报时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"reportId": id, "updated": updated})
}

func (a *api) listReports(c *gin.Context) {
	status := strings.ToLower(strings.TrimSpace(c.Query("status")))
	if status != "" && !validStatuses[status] {
		fail(c, http.StatusBadRequest, "bad_request", "status 非法：只能是 new / wip / done 之一（如 /api/reports?status=new），请修正后重试。")
		return
	}

	reports, err := a.store.ListReports(status)
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：查询上报列表时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	c.JSON(http.StatusOK, reports)
}

func (a *api) getReport(c *gin.Context) {
	id, ok := parseID(c.Param("id"))
	if !ok {
		fail(c, http.StatusBadRequest, "bad_request", "report id 非法：路径 id 必须是正整数（如 /api/reports/123），请确认 id 后重试。")
		return
	}

	r, found, err := a.store.GetReport(id)
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：查询上报详情时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	if !found {
		fail(c, http.StatusNotFound, "not_found", "找不到该 report：id 不存在或已被删，请用 GET /api/reports 确认 id 后重试。")
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"id":          r.ID,
		"domain":      r.Domain,
		"url":         r.URL,
		"title":       r.Title,
		"html":        r.HTML,
		"css":         r.CSS,
		"js_meta":     rawJSON(r.JSMeta),
		"schema_json": rawJSON(r.SchemaJSON),
		"status":      r.Status,
		"created_at":  r.CreatedAt,
	})
}

func (a *api) patchReport(c *gin.Context) {
	id, ok := parseID(c.Param("id"))
	if !ok {
		fail(c, http.StatusBadRequest, "bad_request", "report id 非法：路径 id 必须是正整数（如 /api/reports/123），请确认 id 后重试。")
		return
	}

	var req struct {
		Status string `json:"status"`
	}
	if !decodeBody(c, &req) {
		return
	}
	status := strings.ToLower(strings.TrimSpace(req.Status))
	if !validStatuses[status] {
		fail(c, http.StatusBadRequest, "bad_request", "status 非法：只能是 new / wip / done 之一，请修正后重试。")
		return
	}

	found, err := a.store.UpdateReportStatus(id, status)
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：更新上报状态时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	if !found {
		fail(c, http.StatusNotFound, "not_found", "找不到该 report：id 不存在或已被删，请用 GET /api/reports 确认 id 后重试。")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id, "status": status})
}

func (a *api) postFill(c *gin.Context) {
	var req struct {
		Domain  string          `json:"domain"`
		URL     string          `json:"url"`
		Summary json.RawMessage `json:"summary"`
	}
	if !decodeBody(c, &req) {
		return
	}
	domain := normalizeDomain(req.Domain)
	if domain == "" {
		fail(c, http.StatusBadRequest, "bad_request", "缺少 domain：请带上 domain（如 example.com）后重试。")
		return
	}

	id, err := a.store.InsertFill(domain, strings.TrimSpace(req.URL), jsonBlob(req.Summary, "{}"))
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：保存填写记录时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "fillId": id})
}

func (a *api) postLog(c *gin.Context) {
	var req struct {
		SiteHost     string          `json:"site_host"`
		Kind         string          `json:"kind"`
		ErrorMsg     string          `json:"error_msg"`
		OccurPage    string          `json:"occur_page"`
		ExistingLen  int             `json:"existing_len"`
		Model        string          `json:"model"`
		ProfileID    string          `json:"profile_id"`
	}
	if !decodeBody(c, &req) {
		return
	}
	kind := strings.TrimSpace(req.Kind)
	if kind == "" {
		kind = "merge_parse_error"
	}
	id, err := a.store.InsertMergeLog(MergeLog{
		SiteHost:     strings.TrimSpace(req.SiteHost),
		Kind:         kind,
		ErrorMsg:     req.ErrorMsg,
		OccurPage:    strings.TrimSpace(req.OccurPage),
		ExistingLen:  req.ExistingLen,
		// Diagnostics must never persist candidate-entered lines or model text.
		NewLinesJSON: "[]",
		AIRaw:        "",
		AILen:        0,
		Model:        strings.TrimSpace(req.Model),
		ProfileID:    strings.TrimSpace(req.ProfileID),
	})
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：保存合并日志时出错，请稍后重试。", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "id": id})
}

func (a *api) listLogs(c *gin.Context) {
	limit := 50
	if raw := strings.TrimSpace(c.Query("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n <= 0 {
			fail(c, http.StatusBadRequest, "bad_request", "limit 非法：必须是 1~200 的正整数（如 /api/logs?limit=50），请修正后重试。")
			return
		}
		limit = n
		if limit > 200 {
			limit = 200
		}
	}
	logs, err := a.store.ListMergeLogs(limit)
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：查询合并日志时出错，请稍后重试。", err)
		return
	}
	c.JSON(http.StatusOK, logs)
}

func (a *api) getStats(c *gin.Context) {
	sites, fills, byStatus, err := a.store.Stats()
	if err != nil {
		fail(c, http.StatusInternalServerError, "storage_error", "服务端存储失败：查询统计信息时出错，请稍后重试；仍失败请带上状态码与时间找服务端日志排查。", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"sites":             sites,
		"reports_by_status": byStatus,
		"fills":             fills,
	})
}

// --- helpers ---------------------------------------------------------------

// decodeBody reads one JSON value with a size cap and writes the unified error
// shape itself when decoding fails.
func decodeBody(c *gin.Context, dst any) bool {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBodyBytes)
	err := json.NewDecoder(c.Request.Body).Decode(dst)
	if err == nil {
		return true
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		fail(c, http.StatusRequestEntityTooLarge, "payload_too_large", "请求体超过 32MB 上限：请精简 html/css 后重试。", err)
		return false
	}
	if !errors.Is(err, io.EOF) {
		fail(c, http.StatusBadRequest, "bad_request", "请求体不是合法 JSON：请检查 Content-Type: application/json 与引号、逗号后重试。", err)
		return false
	}
	fail(c, http.StatusBadRequest, "bad_request", "请求体为空：请带上 JSON body 后重试。")
	return false
}

// fail writes the unified error envelope {ok:false, code, message} and logs
// method+path+status+internal err server-side. message carries only what the
// user needs to fix; error mirrors message for older clients. Never pass
// tokens, absolute paths or SQL text into code/message — they stay in logs.
func fail(c *gin.Context, status int, code, msg string, internal ...error) {
	var internalStr string
	if len(internal) > 0 && internal[0] != nil {
		internalStr = internal[0].Error()
	}
	log.Printf("[api] %s %s -> %d code=%s msg=%s internal=%s", c.Request.Method, c.Request.URL.RequestURI(), status, code, msg, internalStr)
	c.JSON(status, gin.H{"ok": false, "code": code, "message": msg, "error": msg})
}

// normalizeDomain lowercases, trims spaces/trailing dots, unwraps URLs to
// hostnames, and strips a leading www. prefix (same as the extension
// background). Callers compare the result with exact equality only.
func normalizeDomain(raw string) string {
	d := strings.ToLower(strings.TrimSpace(raw))
	d = strings.TrimSuffix(d, ".")
	d = strings.TrimPrefix(d, "www.")
	if d == "" {
		return ""
	}
	if strings.Contains(d, "://") {
		if u, err := url.Parse(d); err == nil && u.Hostname() != "" {
			d = strings.ToLower(u.Hostname())
		}
	}
	return d
}

// normalizeReportURL trims surrounding spaces and strips the #fragment so SPA
// hash changes reuse the same row. The query string is kept: different
// queries are different pages.
func normalizeReportURL(raw string) string {
	s := strings.TrimSpace(raw)
	if i := strings.IndexByte(s, '#'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

func parseID(raw string) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

func isJSONObject(data []byte) bool {
	trimmed := bytes.TrimSpace(data)
	return len(trimmed) > 0 && trimmed[0] == '{' && json.Valid(trimmed)
}

func jsonBlob(raw json.RawMessage, fallback string) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return fallback
	}
	return string(trimmed)
}

// rawJSON embeds a stored JSON blob verbatim, degrading to null on bad data so
// the response stays valid JSON.
func rawJSON(s string) json.RawMessage {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" || !json.Valid([]byte(trimmed)) {
		return json.RawMessage("null")
	}
	return json.RawMessage(trimmed)
}
