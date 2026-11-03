package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

// The three tables are the frozen contract (plan §6 / task spec). TEXT columns
// hold JSON blobs; created_at defaults are SQLite UTC "YYYY-MM-DD HH:MM:SS".
const schemaSQL = `
CREATE TABLE IF NOT EXISTS sites (
	domain TEXT PRIMARY KEY,
	adapter_json TEXT NOT NULL DEFAULT '{}',
	version INT NOT NULL DEFAULT 1,
	updated_at TEXT
);
CREATE TABLE IF NOT EXISTS reports (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	domain TEXT,
	url TEXT,
	title TEXT,
	html TEXT,
	css TEXT,
	js_meta TEXT,
	schema_json TEXT,
	status TEXT DEFAULT 'new',
	created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS merge_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	created_at TEXT DEFAULT (datetime('now')),
	site_host TEXT NOT NULL DEFAULT '',
	kind TEXT NOT NULL DEFAULT '',
	error_msg TEXT NOT NULL DEFAULT '',
	occur_page TEXT NOT NULL DEFAULT '',
	existing_len INTEGER NOT NULL DEFAULT 0,
	new_lines_json TEXT NOT NULL DEFAULT '[]',
	ai_raw TEXT NOT NULL DEFAULT '',
	ai_len INTEGER NOT NULL DEFAULT 0,
	model TEXT NOT NULL DEFAULT '',
	profile_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS fills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	domain TEXT,
	url TEXT,
	summary_json TEXT,
	created_at TEXT DEFAULT (datetime('now'))
);
`

// Store wraps the SQLite database. A single connection keeps the pure-Go
// modernc driver simple (no writer contention, no cgo).
type Store struct {
	db   *sql.DB
	path string
}

func OpenStore(path string) (*Store, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("create data dir %s: %w", dir, err)
	}

	dsn := "file:" + path + "?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open sqlite %s: %w", path, err)
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("init sqlite schema: %w", err)
	}
	// Older versions recorded candidate-entered lines and raw model output in
	// merge_logs. Purge those fields during startup so upgrading removes the
	// historical copies as well as preventing new ones from being stored.
	if _, err := db.Exec(`UPDATE merge_logs SET new_lines_json = '[]', ai_raw = '', ai_len = 0 WHERE new_lines_json <> '[]' OR ai_raw <> '' OR ai_len <> 0`); err != nil {
		db.Close()
		return nil, fmt.Errorf("purge sensitive merge logs: %w", err)
	}
	return &Store{db: db, path: path}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// GetSite returns the stored adapter as raw JSON, its version, and whether the
// domain is known. found=false is a normal "fall back to generic extraction".
// The lookup is an exact match on the normalized domain (lowercase, trimmed,
// no trailing dot / www. prefix): no LIKE, no suffix matching, so only a row
// stored for exactly this domain hits.
func (s *Store) GetSite(domain string) (adapter json.RawMessage, version int, found bool, err error) {
	domain = normalizeDomain(domain)
	var adapterJSON []byte
	err = s.db.QueryRow(`SELECT adapter_json, version FROM sites WHERE domain = ?`, domain).
		Scan(&adapterJSON, &version)
	if err == sql.ErrNoRows {
		return nil, 0, false, nil
	}
	if err != nil {
		return nil, 0, false, err
	}
	return json.RawMessage(adapterJSON), version, true, nil
}

func (s *Store) UpsertSite(domain, adapterJSON string, version int) error {
	_, err := s.db.Exec(`
		INSERT INTO sites (domain, adapter_json, version, updated_at)
		VALUES (?, ?, ?, datetime('now'))
		ON CONFLICT(domain) DO UPDATE SET
			adapter_json = excluded.adapter_json,
			version      = excluded.version,
			updated_at   = datetime('now')`,
		domain, adapterJSON, version)
	return err
}

type Report struct {
	ID         int64
	Domain     string
	URL        string
	Title      string
	HTML       string
	CSS        string
	JSMeta     string
	SchemaJSON string
	Status     string
	CreatedAt  string
}

// ReportSummary is the list shape: intentionally no html/css blobs.
type ReportSummary struct {
	ID        int64  `json:"id"`
	Domain    string `json:"domain"`
	URL       string `json:"url"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
}

// UpsertReport keeps one row per URL: if the URL already exists (latest row
// by id), it updates title/html/css/js_meta/schema_json and leaves
// id/status/created_at untouched (a processed status never regresses).
// Otherwise it inserts a new row. It returns the row id and whether an
// existing row was updated. Callers must normalize the URL beforehand.
func (s *Store) UpsertReport(r Report) (int64, bool, error) {
	var existingID int64
	err := s.db.QueryRow(`SELECT id FROM reports WHERE url = ? ORDER BY id DESC LIMIT 1`, r.URL).Scan(&existingID)
	if err != nil && err != sql.ErrNoRows {
		return 0, false, err
	}
	if err == nil {
		if _, err := s.db.Exec(`UPDATE reports SET title = ?, html = ?, css = ?, js_meta = ?, schema_json = ? WHERE id = ?`, r.Title, r.HTML, r.CSS, r.JSMeta, r.SchemaJSON, existingID); err != nil {
			return 0, false, err
		}
		return existingID, true, nil
	}
	id, err := s.InsertReport(r)
	if err != nil {
		return 0, false, err
	}
	return id, false, nil
}

func (s *Store) InsertReport(r Report) (int64, error) {
	res, err := s.db.Exec(`
		INSERT INTO reports (domain, url, title, html, css, js_meta, schema_json, status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		r.Domain, r.URL, r.Title, r.HTML, r.CSS, r.JSMeta, r.SchemaJSON, r.Status)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListReports(status string) ([]ReportSummary, error) {
	query := `SELECT id, COALESCE(domain, ''), COALESCE(url, ''), COALESCE(title, ''),
	                 COALESCE(status, 'new'), COALESCE(created_at, '')
	          FROM reports`
	args := []any{}
	if status != "" {
		query += ` WHERE status = ?`
		args = append(args, status)
	}
	query += ` ORDER BY id DESC`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ReportSummary, 0)
	for rows.Next() {
		var r ReportSummary
		if err := rows.Scan(&r.ID, &r.Domain, &r.URL, &r.Title, &r.Status, &r.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) GetReport(id int64) (Report, bool, error) {
	var r Report
	err := s.db.QueryRow(`
		SELECT id, COALESCE(domain, ''), COALESCE(url, ''), COALESCE(title, ''),
		       COALESCE(html, ''), COALESCE(css, ''), COALESCE(js_meta, ''),
		       COALESCE(schema_json, ''), COALESCE(status, 'new'), COALESCE(created_at, '')
		FROM reports WHERE id = ?`, id).
		Scan(&r.ID, &r.Domain, &r.URL, &r.Title, &r.HTML, &r.CSS, &r.JSMeta,
			&r.SchemaJSON, &r.Status, &r.CreatedAt)
	if err == sql.ErrNoRows {
		return Report{}, false, nil
	}
	if err != nil {
		return Report{}, false, err
	}
	return r, true, nil
}

// UpdateReportStatus reports whether the row exists; keeps PATCH idempotent.
func (s *Store) UpdateReportStatus(id int64, status string) (bool, error) {
	res, err := s.db.Exec(`UPDATE reports SET status = ? WHERE id = ?`, status, id)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if n > 0 {
		return true, nil
	}
	var exists int
	if err := s.db.QueryRow(`SELECT COUNT(1) FROM reports WHERE id = ?`, id).Scan(&exists); err != nil {
		return false, err
	}
	return exists > 0, nil
}

// MergeLog records one merge-failure/AI-call diagnostic row. The merge_logs
// table is additive: existing sites/reports/fills tables are untouched, and
// CREATE TABLE IF NOT EXISTS migrates old DB files on OpenStore.
type MergeLog struct {
	ID           int64  `json:"id"`
	CreatedAt    string `json:"created_at"`
	SiteHost     string `json:"site_host"`
	Kind         string `json:"kind"`
	ErrorMsg     string `json:"error_msg"`
	OccurPage    string `json:"occur_page"`
	ExistingLen  int    `json:"existing_len"`
	NewLinesJSON string `json:"new_lines_json"`
	AIRaw        string `json:"ai_raw"`
	AILen        int    `json:"ai_len"`
	Model        string `json:"model"`
	ProfileID    string `json:"profile_id"`
}

func (s *Store) InsertMergeLog(m MergeLog) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO merge_logs (site_host, kind, error_msg, occur_page, existing_len, new_lines_json, ai_raw, ai_len, model, profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		m.SiteHost, m.Kind, m.ErrorMsg, m.OccurPage, m.ExistingLen, m.NewLinesJSON, m.AIRaw, m.AILen, m.Model, m.ProfileID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListMergeLogs(limit int) ([]MergeLog, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT id, COALESCE(created_at, ''), COALESCE(site_host, ''), COALESCE(kind, ''), COALESCE(error_msg, ''), COALESCE(occur_page, ''), COALESCE(existing_len, 0), COALESCE(new_lines_json, '[]'), COALESCE(ai_raw, ''), COALESCE(ai_len, 0), COALESCE(model, ''), COALESCE(profile_id, '')
	          FROM merge_logs ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]MergeLog, 0)
	for rows.Next() {
		var m MergeLog
		if err := rows.Scan(&m.ID, &m.CreatedAt, &m.SiteHost, &m.Kind, &m.ErrorMsg, &m.OccurPage, &m.ExistingLen, &m.NewLinesJSON, &m.AIRaw, &m.AILen, &m.Model, &m.ProfileID); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) InsertFill(domain, url, summaryJSON string) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO fills (domain, url, summary_json) VALUES (?, ?, ?)`,
		domain, url, summaryJSON)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// Stats returns site count, fill count and report counts per status. All three
// known statuses are present with zero defaults.
func (s *Store) Stats() (sites int, fills int, byStatus map[string]int, err error) {
	byStatus = map[string]int{"new": 0, "wip": 0, "done": 0}

	if err = s.db.QueryRow(`SELECT COUNT(1) FROM sites`).Scan(&sites); err != nil {
		return 0, 0, nil, err
	}
	if err = s.db.QueryRow(`SELECT COUNT(1) FROM fills`).Scan(&fills); err != nil {
		return 0, 0, nil, err
	}

	rows, err := s.db.Query(`SELECT COALESCE(status, 'new'), COUNT(1) FROM reports GROUP BY COALESCE(status, 'new')`)
	if err != nil {
		return 0, 0, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var status string
		var n int
		if err = rows.Scan(&status, &n); err != nil {
			return 0, 0, nil, err
		}
		byStatus[status] = n
	}
	return sites, fills, byStatus, rows.Err()
}
