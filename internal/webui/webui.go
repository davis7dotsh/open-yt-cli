// Package webui is the shared look of oytcd's pages: the base layout and its
// stylesheet, and rendering with no-store and anti-framing headers.
package webui

import (
	"bytes"
	_ "embed"
	"html/template"
	"io/fs"
	"log/slog"
	"net/http"
)

//go:embed layout.html
var layout string

// Parse parses the page templates matching patterns in fsys together with
// the shared "head" (taking the page title) and "foot" templates.
func Parse(fsys fs.FS, funcs template.FuncMap, patterns ...string) *template.Template {
	return template.Must(template.Must(template.New("").Funcs(funcs).Parse(layout)).ParseFS(fsys, patterns...))
}

// Render executes the named template and writes it with status.
func Render(w http.ResponseWriter, pages *template.Template, status int, name string, data any) {
	var body bytes.Buffer
	if err := pages.ExecuteTemplate(&body, name, data); err != nil {
		slog.Error("render page", "page", name, "err", err)
		http.Error(w, "Something went wrong.", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Content-Security-Policy", "frame-ancestors 'none'")
	h.Set("Referrer-Policy", "same-origin")
	w.WriteHeader(status)
	w.Write(body.Bytes())
}
