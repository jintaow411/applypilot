package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	appVersion = "0.1.0"
	listenAddr = "127.0.0.1:17880"
	tokenBytes = 32
)

// main starts the local-only Gin server. It prints the pairing token to stdout
// on every start (generating one on first start) so the sidepanel can pair.
func main() {
	gin.SetMode(gin.ReleaseMode)

	baseDir, err := resolveBaseDir()
	if err != nil {
		log.Fatalf("auto-info-server: resolve base dir: %v", err)
	}
	allowedOrigins, err := configuredExtensionOrigins()
	if err != nil {
		log.Fatalf("auto-info-server: extension origin: %v", err)
	}

	tokenPath := filepath.Join(baseDir, ".token")
	token, created, err := loadOrCreateToken(tokenPath)
	if err != nil {
		log.Fatalf("auto-info-server: token: %v", err)
	}

	dbPath := filepath.Join(baseDir, "data", "auto-info.db")
	store, err := OpenStore(dbPath)
	if err != nil {
		log.Fatalf("auto-info-server: %v", err)
	}
	defer store.Close()

	router := newRouter(store, token, allowedOrigins)

	fmt.Printf("auto-info-server %s\n", appVersion)
	fmt.Printf("  listen : http://%s\n", listenAddr)
	fmt.Printf("  sqlite : %s\n", dbPath)
	fmt.Printf("  origin : %s\n", strings.Join(sortedOrigins(allowedOrigins), ", "))
	if created {
		fmt.Printf("  token  : %s (generated, saved to %s, mode 0600)\n", token, tokenPath)
	} else {
		fmt.Printf("  token  : %s (loaded from %s)\n", token, tokenPath)
	}

	srv := &http.Server{
		Addr:              listenAddr,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-errCh:
		log.Fatalf("auto-info-server: listen %s: %v", listenAddr, err)
	case sig := <-sigCh:
		fmt.Printf("auto-info-server: %v received, shutting down\n", sig)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Printf("auto-info-server: shutdown: %v", err)
	}
}

// configuredExtensionOrigins parses the exact extension origins permitted to
// make browser requests. Chrome assigns unpacked extensions an ID, so this is
// deliberately explicit instead of trusting every chrome-extension:// origin.
func configuredExtensionOrigins() (map[string]struct{}, error) {
	raw := strings.TrimSpace(os.Getenv("AUTO_INFO_EXTENSION_ORIGIN"))
	if raw == "" {
		return nil, errors.New("AUTO_INFO_EXTENSION_ORIGIN is required (for example chrome-extension://<extension-id>)")
	}
	origins := make(map[string]struct{})
	for _, item := range strings.Split(raw, ",") {
		origin := strings.TrimSuffix(strings.TrimSpace(item), "/")
		u, err := url.Parse(origin)
		if err != nil || u.Scheme != "chrome-extension" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return nil, fmt.Errorf("invalid extension origin %q; expected chrome-extension://<extension-id>", item)
		}
		origins[origin] = struct{}{}
	}
	if len(origins) == 0 {
		return nil, errors.New("AUTO_INFO_EXTENSION_ORIGIN contains no extension origins")
	}
	return origins, nil
}

func sortedOrigins(origins map[string]struct{}) []string {
	values := make([]string, 0, len(origins))
	for origin := range origins {
		values = append(values, origin)
	}
	sort.Strings(values)
	return values
}

// resolveBaseDir keeps data/ and .token next to the sources when the binary is
// run from the server directory (or built there), so `./auto-info-server`,
// `go run .` and the packaged binary all agree on where state lives.
// AUTO_INFO_HOME overrides the location.
func resolveBaseDir() (string, error) {
	if v := strings.TrimSpace(os.Getenv("AUTO_INFO_HOME")); v != "" {
		return filepath.Abs(v)
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	if isFile(filepath.Join(cwd, "go.mod")) {
		return cwd, nil
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		if isFile(filepath.Join(dir, "go.mod")) {
			return dir, nil
		}
	}
	return cwd, nil
}

func isFile(path string) bool {
	st, err := os.Stat(path)
	return err == nil && !st.IsDir()
}

// loadOrCreateToken reuses a valid existing token (so restarts do not break an
// already-paired panel) and otherwise generates 32 random bytes as hex.
func loadOrCreateToken(path string) (token string, created bool, err error) {
	if data, readErr := os.ReadFile(path); readErr == nil {
		if tok := strings.TrimSpace(string(data)); isHexToken(tok) {
			if chmodErr := os.Chmod(path, 0o600); chmodErr != nil {
				return "", false, fmt.Errorf("chmod %s: %w", path, chmodErr)
			}
			return tok, false, nil
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return "", false, fmt.Errorf("read %s: %w", path, readErr)
	}

	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", false, fmt.Errorf("generate random token: %w", err)
	}
	tok := hex.EncodeToString(buf)
	if err := os.WriteFile(path, []byte(tok+"\n"), 0o600); err != nil {
		return "", false, fmt.Errorf("write %s: %w", path, err)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return "", false, fmt.Errorf("chmod %s: %w", path, err)
	}
	return tok, true, nil
}

func isHexToken(s string) bool {
	if len(s) != tokenBytes*2 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= '0' && r <= '9':
		case r >= 'a' && r <= 'f':
		case r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}
