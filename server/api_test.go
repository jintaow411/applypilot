package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

const testToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
const testExtensionOrigin = "chrome-extension://abcdefghijklmnop"

func newTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.ReleaseMode)
	st, err := OpenStore(filepath.Join(t.TempDir(), "data", "auto-info.db"))
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return newRouter(st, testToken, map[string]struct{}{testExtensionOrigin: {}})
}

func doReq(t *testing.T, r http.Handler, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	withoutAuth := headers != nil && headers["X-Test-No-Auth"] == "1"
	for k, v := range headers {
		if k == "X-Test-No-Auth" {
			continue
		}
		req.Header.Set(k, v)
	}
	if strings.HasPrefix(path, "/api/") && !withoutAuth && req.Header.Get("Authorization") == "" {
		req.Header.Set("Authorization", "Bearer "+testToken)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func decodeJSON(t *testing.T, w *httptest.ResponseRecorder, dst any) {
	t.Helper()
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("expected JSON content type, got %q (body %s)", ct, w.Body.String())
	}
	if err := json.Unmarshal(w.Body.Bytes(), dst); err != nil {
		t.Fatalf("decode response %q: %v", w.Body.String(), err)
	}
}

func authHeader() map[string]string {
	return map[string]string{"Authorization": "Bearer " + testToken}
}

func TestHealthAndUnknownRoutes(t *testing.T) {
	r := newTestRouter(t)

	w := doReq(t, r, http.MethodGet, "/healthz", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("/healthz status = %d body %s", w.Code, w.Body.String())
	}
	var health struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}
	decodeJSON(t, w, &health)
	if !health.OK || health.Version != "0.1.0" {
		t.Fatalf("health = %+v", health)
	}

	w = doReq(t, r, http.MethodGet, "/api/does-not-exist", "", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown route status = %d", w.Code)
	}
	var errBody struct {
		Error string `json:"error"`
	}
	decodeJSON(t, w, &errBody)
	if errBody.Error == "" {
		t.Fatal("unknown route must return {error:string}")
	}

	w = doReq(t, r, http.MethodDelete, "/healthz", "", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("method mismatch status = %d", w.Code)
	}
}

func TestSchemaLifecycle(t *testing.T) {
	r := newTestRouter(t)

	w := doReq(t, r, http.MethodGet, "/api/schema?domain=example.com", "", nil)
	var schema struct {
		Found   bool            `json:"found"`
		Adapter json.RawMessage `json:"adapter"`
		Version int             `json:"version"`
	}
	if w.Code != http.StatusOK {
		t.Fatalf("get schema status = %d body %s", w.Code, w.Body.String())
	}
	decodeJSON(t, w, &schema)
	if schema.Found || string(schema.Adapter) != "null" || schema.Version != 0 {
		t.Fatalf("missing site = %+v (adapter %s)", schema, schema.Adapter)
	}

	var errBody struct {
		Error string `json:"error"`
	}
	body := `{"adapter":{"aliases":{}},"version":1}`
	w = doReq(t, r, http.MethodPut, "/api/sites/example.com/schema", body, map[string]string{"X-Test-No-Auth": "1"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d body %s", w.Code, w.Body.String())
	}
	decodeJSON(t, w, &errBody)

	w = doReq(t, r, http.MethodPut, "/api/sites/example.com/schema", body,
		map[string]string{"Authorization": "Bearer wrong"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong token status = %d", w.Code)
	}

	w = doReq(t, r, http.MethodPut, "/api/sites/example.com/schema",
		`{"adapter":"nope","version":1}`, authHeader())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("non-object adapter status = %d body %s", w.Code, w.Body.String())
	}
	decodeJSON(t, w, &errBody)

	w = doReq(t, r, http.MethodPut, "/api/sites/example.com/schema", `{not json`, authHeader())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON status = %d", w.Code)
	}

	w = doReq(t, r, http.MethodPut, "/api/sites/example.com/schema", body, authHeader())
	if w.Code != http.StatusOK {
		t.Fatalf("upsert status = %d body %s", w.Code, w.Body.String())
	}

	w = doReq(t, r, http.MethodGet, "/api/schema?domain=example.com", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("get schema after upsert status = %d body %s", w.Code, w.Body.String())
	}
	decodeJSON(t, w, &schema)
	if !schema.Found || schema.Version != 1 {
		t.Fatalf("schema after upsert = %+v", schema)
	}
	if string(schema.Adapter) != `{"aliases":{}}` {
		t.Fatalf("adapter = %s", schema.Adapter)
	}

	w = doReq(t, r, http.MethodPut, "/api/sites/example.com/schema",
		`{"adapter":{"aliases":{"profileKey":["a"]}},"version":2}`, authHeader())
	if w.Code != http.StatusOK {
		t.Fatalf("second upsert status = %d", w.Code)
	}
	w = doReq(t, r, http.MethodGet, "/api/schema?domain=example.com", "", nil)
	decodeJSON(t, w, &schema)
	if schema.Version != 2 || !strings.Contains(string(schema.Adapter), "profileKey") {
		t.Fatalf("updated schema = %+v adapter %s", schema, schema.Adapter)
	}

	w = doReq(t, r, http.MethodGet, "/api/schema", "", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing domain status = %d", w.Code)
	}
}

func TestReportsLifecycle(t *testing.T) {
	r := newTestRouter(t)

	w := doReq(t, r, http.MethodPost, "/api/reports", `{"domain":"example.com"}`, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("incomplete report status = %d", w.Code)
	}
	var errBody struct {
		Error string `json:"error"`
	}
	decodeJSON(t, w, &errBody)

	payload := `{
		"domain":"example.com",
		"url":"https://example.com/job",
		"title":"t",
		"html":"<html></html>",
		"css":"body{}",
		"jsMeta":{"scripts":[],"stylesheets":[]},
		"schema":{"url":"x","title":"t","fields":[]},
		"note":"agent: needs adapter"
	}`
	w = doReq(t, r, http.MethodPost, "/api/reports", payload, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("post report status = %d body %s", w.Code, w.Body.String())
	}
	var created struct {
		ReportID int64 `json:"reportId"`
	}
	decodeJSON(t, w, &created)
	if created.ReportID <= 0 {
		t.Fatalf("reportId = %d", created.ReportID)
	}

	w = doReq(t, r, http.MethodGet, "/api/reports?status=new", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list reports status = %d", w.Code)
	}
	var list []map[string]any
	decodeJSON(t, w, &list)
	if len(list) != 1 {
		t.Fatalf("list length = %d", len(list))
	}
	if _, hasHTML := list[0]["html"]; hasHTML {
		t.Fatal("report list must not include html")
	}
	if list[0]["status"] != "new" || list[0]["domain"] != "example.com" {
		t.Fatalf("list item = %+v", list[0])
	}
	if list[0]["created_at"] == "" {
		t.Fatal("created_at must be populated")
	}

	w = doReq(t, r, http.MethodGet, "/api/reports?status=bogus", "", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid status filter = %d", w.Code)
	}

	idStr := strconvFormat(created.ReportID)
	w = doReq(t, r, http.MethodGet, "/api/reports/"+idStr, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("detail status = %d body %s", w.Code, w.Body.String())
	}
	var detail struct {
		ID         int64           `json:"id"`
		Domain     string          `json:"domain"`
		URL        string          `json:"url"`
		Title      string          `json:"title"`
		HTML       string          `json:"html"`
		CSS        string          `json:"css"`
		JSMeta     json.RawMessage `json:"js_meta"`
		SchemaJSON json.RawMessage `json:"schema_json"`
		Status     string          `json:"status"`
		CreatedAt  string          `json:"created_at"`
	}
	decodeJSON(t, w, &detail)
	if detail.ID != created.ReportID || detail.HTML != "<html></html>" || detail.CSS != "body{}" {
		t.Fatalf("detail = %+v", detail)
	}
	if detail.Status != "new" || !strings.Contains(string(detail.JSMeta), `"scripts"`) {
		t.Fatalf("detail js_meta = %s status %s", detail.JSMeta, detail.Status)
	}
	if !strings.Contains(string(detail.SchemaJSON), `"fields"`) {
		t.Fatalf("detail schema_json = %s", detail.SchemaJSON)
	}
	if strings.Contains(string(detail.SchemaJSON), `"note"`) {
		t.Fatalf("note must not leak into contract-bound schema_json: %s", detail.SchemaJSON)
	}

	w = doReq(t, r, http.MethodPatch, "/api/reports/"+idStr, `{"status":"bogus"}`, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid patch status = %d", w.Code)
	}

	w = doReq(t, r, http.MethodPatch, "/api/reports/"+idStr, `{"status":"done"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("patch status = %d body %s", w.Code, w.Body.String())
	}

	w = doReq(t, r, http.MethodGet, "/api/reports?status=done", "", nil)
	decodeJSON(t, w, &list)
	if len(list) != 1 {
		t.Fatalf("done list length = %d", len(list))
	}

	w = doReq(t, r, http.MethodPatch, "/api/reports/999999", `{"status":"wip"}`, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("patch missing report = %d", w.Code)
	}
	w = doReq(t, r, http.MethodGet, "/api/reports/999999", "", nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("missing report detail = %d", w.Code)
	}
	w = doReq(t, r, http.MethodGet, "/api/reports/not-a-number", "", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad report id = %d", w.Code)
	}

	w = doReq(t, r, http.MethodGet, "/api/stats", "", nil)
	var stats struct {
		Sites           int            `json:"sites"`
		ReportsByStatus map[string]int `json:"reports_by_status"`
		Fills           int            `json:"fills"`
	}
	decodeJSON(t, w, &stats)
	if stats.Sites != 0 || stats.Fills != 0 {
		t.Fatalf("stats = %+v", stats)
	}
	if stats.ReportsByStatus["done"] != 1 || stats.ReportsByStatus["new"] != 0 || stats.ReportsByStatus["wip"] != 0 {
		t.Fatalf("reports_by_status = %+v", stats.ReportsByStatus)
	}
}

func TestReportsUpsertSameURL(t *testing.T) {
	r := newTestRouter(t)

	post := func(url, title, html string) (int64, bool) {
		t.Helper()
		body := `{"domain":"example.com","url":` + strconv.Quote(url) + `,"title":` + strconv.Quote(title) + `,"html":` + strconv.Quote(html) + `,"css":"body{}","jsMeta":{},"schema":{}}`
		w := doReq(t, r, http.MethodPost, "/api/reports", body, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("post %q status = %d body %s", url, w.Code, w.Body.String())
		}
		var resp struct {
			ReportID int64 `json:"reportId"`
			Updated  bool   `json:"updated"`
		}
		decodeJSON(t, w, &resp)
		if resp.ReportID <= 0 {
			t.Fatalf("reportId = %d", resp.ReportID)
		}
		return resp.ReportID, resp.Updated
	}
	getDetail := func(id int64) (title, html, status, createdAt string) {
		t.Helper()
		w := doReq(t, r, http.MethodGet, "/api/reports/"+strconvFormat(id), "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("detail %d status = %d", id, w.Code)
		}
		var d struct {
			Title     string `json:"title"`
			HTML      string `json:"html"`
			Status    string `json:"status"`
			CreatedAt string `json:"created_at"`
		}
		decodeJSON(t, w, &d)
		return d.Title, d.HTML, d.Status, d.CreatedAt
	}
	listLen := func() int {
		t.Helper()
		w := doReq(t, r, http.MethodGet, "/api/reports", "", nil)
		if w.Code != http.StatusOK {
			t.Fatalf("list status = %d", w.Code)
		}
		var list []map[string]any
		decodeJSON(t, w, &list)
		return len(list)
	}

	id1, updated1 := post("https://example.com/job", "t1", "<html>v1</html>")
	if updated1 {
		t.Fatal("first report must return updated=false")
	}
	_, _, _, created1 := getDetail(id1)

	// Mark processed, then re-report the same URL: must update in place.
	w := doReq(t, r, http.MethodPatch, "/api/reports/"+strconvFormat(id1), `{"status":"done"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("patch done status = %d body %s", w.Code, w.Body.String())
	}

	id2, updated2 := post("https://example.com/job", "t2", "<html>v2</html>")
	if !updated2 || id2 != id1 {
		t.Fatalf("second report = id %d updated=%v, want same id %d updated=true", id2, updated2, id1)
	}
	if n := listLen(); n != 1 {
		t.Fatalf("row count after duplicate = %d, want 1", n)
	}
	title, html, status, created2 := getDetail(id1)
	if title != "t2" || html != "<html>v2</html>" {
		t.Fatalf("content not updated: title=%q html=%q", title, html)
	}
	if status != "done" {
		t.Fatalf("status regressed to %q, want done", status)
	}
	if created2 != created1 {
		t.Fatalf("created_at changed %q -> %q", created1, created2)
	}

	// SPA hash change is the same page.
	id3, updated3 := post("https://example.com/job#section2", "t3", "<html>v3</html>")
	if !updated3 || id3 != id1 {
		t.Fatalf("fragment report = id %d updated=%v, want same id %d updated=true", id3, updated3, id1)
	}
	if n := listLen(); n != 1 {
		t.Fatalf("row count after fragment = %d, want 1", n)
	}
	if _, _, status, _ = getDetail(id1); status != "done" {
		t.Fatalf("status regressed after fragment to %q", status)
	}

	// Different query string is a different page.
	id4, updated4 := post("https://example.com/job?pos=2", "t4", "<html>v4</html>")
	if updated4 || id4 == id1 {
		t.Fatalf("query report = id %d updated=%v, want new id", id4, updated4)
	}
	if n := listLen(); n != 2 {
		t.Fatalf("row count after query variant = %d, want 2", n)
	}
}

func TestFillsAndCORS(t *testing.T) {
	r := newTestRouter(t)

	// Reports and logs contain locally stored page and diagnostic data, so every
	// API route must reject an unauthenticated same-machine caller.
	w := doReq(t, r, http.MethodGet, "/api/reports", "", map[string]string{"X-Test-No-Auth": "1"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated reports status = %d body %s", w.Code, w.Body.String())
	}

	w = doReq(t, r, http.MethodPost, "/api/fills",
		`{"domain":"example.com","url":"https://example.com/job","summary":{"filled":3}}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("post fill status = %d body %s", w.Code, w.Body.String())
	}
	var fill struct {
		FillID int64 `json:"fillId"`
	}
	decodeJSON(t, w, &fill)
	if fill.FillID <= 0 {
		t.Fatalf("fillId = %d", fill.FillID)
	}

	w = doReq(t, r, http.MethodPost, "/api/fills", `{"url":"x"}`, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("fill without domain = %d", w.Code)
	}

	w = doReq(t, r, http.MethodGet, "/api/stats", "", nil)
	var stats struct {
		Fills int `json:"fills"`
	}
	decodeJSON(t, w, &stats)
	if stats.Fills != 1 {
		t.Fatalf("fills = %d", stats.Fills)
	}

	extOrigin := testExtensionOrigin
	w = doReq(t, r, http.MethodOptions, "/api/reports", "", map[string]string{
		"Origin":                         extOrigin,
		"Access-Control-Request-Method":  "POST",
		"Access-Control-Request-Headers": "authorization,content-type",
	})
	if w.Code != http.StatusNoContent {
		t.Fatalf("preflight status = %d", w.Code)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != extOrigin {
		t.Fatalf("preflight ACAO = %q", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "PATCH") {
		t.Fatalf("preflight methods = %q", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") {
		t.Fatalf("preflight headers = %q", got)
	}

	w = doReq(t, r, http.MethodGet, "/healthz", "", map[string]string{"Origin": extOrigin})
	if w.Code != http.StatusOK || w.Header().Get("Access-Control-Allow-Origin") != extOrigin {
		t.Fatalf("extension origin status=%d ACAO=%q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
	}

	w = doReq(t, r, http.MethodGet, "/healthz", "", map[string]string{"Origin": "https://evil.example"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("disallowed origin status = %d", w.Code)
	}
	if w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("disallowed origin must not get ACAO")
	}
	decodeJSON(t, w, &struct {
		Error string `json:"error"`
	}{})

	w = doReq(t, r, http.MethodGet, "/healthz", "", map[string]string{"Origin": "chrome-extension://otherextensionid"})
	if w.Code != http.StatusForbidden {
		t.Fatalf("unconfigured extension origin status = %d", w.Code)
	}

	w = doReq(t, r, http.MethodOptions, "/api/reports", "", map[string]string{
		"Origin":                        "https://evil.example",
		"Access-Control-Request-Method": "POST",
	})
	if w.Code != http.StatusForbidden {
		t.Fatalf("disallowed preflight status = %d", w.Code)
	}

	w = doReq(t, r, http.MethodGet, "/healthz", "", nil)
	if w.Code != http.StatusOK || w.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("no-origin status=%d ACAO=%q", w.Code, w.Header().Get("Access-Control-Allow-Origin"))
	}
}

func TestTokenFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".token")

	token, created, err := loadOrCreateToken(path)
	if err != nil {
		t.Fatalf("loadOrCreateToken: %v", err)
	}
	if !created || len(token) != tokenBytes*2 {
		t.Fatalf("first token created=%v len=%d", created, len(token))
	}
	st, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat token: %v", err)
	}
	if perm := st.Mode().Perm(); perm != 0o600 {
		t.Fatalf("token mode = %o, want 600", perm)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read token: %v", err)
	}
	if strings.TrimSpace(string(raw)) != token {
		t.Fatal("token file content mismatch")
	}

	again, createdAgain, err := loadOrCreateToken(path)
	if err != nil || createdAgain || again != token {
		t.Fatalf("second load token same=%v created=%v err=%v", again == token, createdAgain, err)
	}
}

func TestErrorEnvelope(t *testing.T) {
	r := newTestRouter(t)

	type envelope struct {
		OK      bool   `json:"ok"`
		Code    string `json:"code"`
		Message string `json:"message"`
		Err     string `json:"error"`
	}
	check := func(w *httptest.ResponseRecorder, wantStatus int, wantCode string) envelope {
		t.Helper()
		if w.Code != wantStatus {
			t.Fatalf("status = %d want %d body %s", w.Code, wantStatus, w.Body.String())
		}
		var e envelope
		decodeJSON(t, w, &e)
		if e.OK {
			t.Fatalf("ok must be false: %+v body %s", e, w.Body.String())
		}
		if e.Code != wantCode {
			t.Fatalf("code = %q want %q body %s", e.Code, wantCode, w.Body.String())
		}
		if e.Message == "" || e.Err == "" {
			t.Fatalf("message/error must be non-empty: %+v", e)
		}
		body := w.Body.String()
		for _, leak := range []string{testToken, ".db", "SELECT", "sqlite", "/Users/", "/tmp/"} {
			if leak != "" && strings.Contains(body, leak) {
				t.Fatalf("response leaks %q: %s", leak, body)
			}
		}
		return e
	}

	// 1. token 无效
	w := doReq(t, r, http.MethodPut, "/api/sites/example.com/schema",
		`{"adapter":{},"version":1}`, map[string]string{"Authorization": "Bearer wrong"})
	check(w, http.StatusUnauthorized, "unauthorized")

	// 2. domain 为空
	w = doReq(t, r, http.MethodGet, "/api/schema", "", nil)
	e := check(w, http.StatusBadRequest, "bad_request")
	if !strings.Contains(e.Message, "domain") {
		t.Fatalf("domain message = %q", e.Message)
	}

	// 3. adapter 非法 JSON（字符串而非对象）
	w = doReq(t, r, http.MethodPut, "/api/sites/example.com/schema",
		`{"adapter":"nope","version":1}`, authHeader())
	check(w, http.StatusBadRequest, "bad_request")

	// 4. report id 不存在
	w = doReq(t, r, http.MethodGet, "/api/reports/999999", "", nil)
	check(w, http.StatusNotFound, "not_found")

	// 5. status 非法值
	w = doReq(t, r, http.MethodGet, "/api/reports?status=bogus", "", nil)
	check(w, http.StatusBadRequest, "bad_request")
	w = doReq(t, r, http.MethodPatch, "/api/reports/1", `{"status":"bogus"}`, nil)
	check(w, http.StatusBadRequest, "bad_request")

	// 未知路由也是统一包
	w = doReq(t, r, http.MethodGet, "/api/does-not-exist", "", nil)
	check(w, http.StatusNotFound, "not_found")
}

func strconvFormat(id int64) string {
	return strconv.FormatInt(id, 10)
}
