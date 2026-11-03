package main

import (
	"net/http"
	"strconv"
	"strings"
	"testing"
)

func TestMergeLogsWriteAndQuery(t *testing.T) {
	r := newTestRouter(t)

	// 空库先查：应返回空数组而非 null/500（老库迁移后表存在）。
	w := doReq(t, r, http.MethodGet, "/api/logs?limit=50", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("empty list status = %d body %s", w.Code, w.Body.String())
	}
	if strings.TrimSpace(w.Body.String()) != "[]" {
		t.Fatalf("empty list body = %s, want []", w.Body.String())
	}

	body := `{"site_host":"example.com","kind":"merge_parse_error","error_msg":"parse fail at line 3","occur_page":"App.tsx handleImportManual","existing_len":5,"new_lines_json":["a","b"],"ai_raw":"raw-text","model":"test-model","profile_id":"default"}`
	w = doReq(t, r, http.MethodPost, "/api/logs", body, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("post log status = %d body %s", w.Code, w.Body.String())
	}
	var created struct {
		OK bool  `json:"ok"`
		ID int64 `json:"id"`
	}
	decodeJSON(t, w, &created)
	if !created.OK || created.ID <= 0 {
		t.Fatalf("created = %+v body %s", created, w.Body.String())
	}

	// kind 为空时默认 merge_parse_error；模型原文一律不入库。
	w = doReq(t, r, http.MethodPost, "/api/logs", `{"site_host":"x.com","occur_page":"App.tsx handleImportManual","ai_raw":"abc"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("post defaulted log status = %d body %s", w.Code, w.Body.String())
	}

	w = doReq(t, r, http.MethodGet, "/api/logs?limit=50", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d body %s", w.Code, w.Body.String())
	}
	var list []MergeLog
	decodeJSON(t, w, &list)
	if len(list) != 2 {
		t.Fatalf("list length = %d body %s", len(list), w.Body.String())
	}
	if list[0].ID <= list[1].ID {
		t.Fatalf("list must be id DESC: %+v", list)
	}
	// 最新一条是 kind 缺省的那条
	if list[0].Kind != "merge_parse_error" || list[0].AILen != 0 || list[0].SiteHost != "x.com" {
		t.Fatalf("defaulted row = %+v", list[0])
	}
	found := false
	for _, m := range list {
		if m.ID == created.ID {
			found = true
			if m.ErrorMsg != "parse fail at line 3" || m.OccurPage != "App.tsx handleImportManual" || m.ExistingLen != 5 || m.Model != "test-model" || m.ProfileID != "default" {
				t.Fatalf("row mismatch = %+v", m)
			}
			if m.NewLinesJSON != "[]" || m.AIRaw != "" || m.AILen != 0 {
				t.Fatalf("sensitive payload must be dropped, got %+v", m)
			}
			if m.CreatedAt == "" {
				t.Fatalf("created_at empty: %+v", m)
			}
		}
	}
	if !found {
		t.Fatalf("created id %d not in list", created.ID)
	}

	// limit=1 只回一条；非法 limit 400；超上限截断到 200 不报错。
	w = doReq(t, r, http.MethodGet, "/api/logs?limit=1", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("limit=1 status = %d", w.Code)
	}
	var one []MergeLog
	decodeJSON(t, w, &one)
	if len(one) != 1 {
		t.Fatalf("limit=1 length = %d", len(one))
	}
	w = doReq(t, r, http.MethodGet, "/api/logs?limit=0", "", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("limit=0 status = %d, want 400", w.Code)
	}
	w = doReq(t, r, http.MethodGet, "/api/logs?limit=999", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("limit=999 status = %d", w.Code)
	}

	// 非法 JSON 400。
	w = doReq(t, r, http.MethodPost, "/api/logs", "{not json", nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad JSON status = %d, want 400", w.Code)
	}

	// 现有接口不受影响。
	w = doReq(t, r, http.MethodGet, "/api/stats", "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("stats status = %d", w.Code)
	}
	_ = strconv.FormatInt(created.ID, 10)
}
