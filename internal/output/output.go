// Package output renders API resources in stable human and machine formats.
package output

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"

	"open-yt-cli/internal/youtube"
)

type Options struct {
	Format   string
	Columns  []string
	NoHeader bool
}

var validFormats = map[string]bool{"table": true, "json": true, "jsonl": true, "tsv": true}

func Render(w io.Writer, result youtube.ListResult, options Options) error {
	if !validFormats[options.Format] {
		return fmt.Errorf("unsupported format %q (use table, json, jsonl, or tsv)", options.Format)
	}
	switch options.Format {
	case "json":
		encoder := json.NewEncoder(w)
		encoder.SetEscapeHTML(false)
		encoder.SetIndent("", "  ")
		return encoder.Encode(result)
	case "jsonl":
		encoder := json.NewEncoder(w)
		encoder.SetEscapeHTML(false)
		for _, item := range result.Items {
			if err := encoder.Encode(item); err != nil {
				return err
			}
		}
		return nil
	case "table", "tsv":
		return renderRows(w, result.Items, options)
	default:
		return errors.New("unreachable output format")
	}
}

func RenderObject(w io.Writer, object map[string]any, format string, columns []string, noHeader bool) error {
	if format == "json" || format == "jsonl" {
		encoder := json.NewEncoder(w)
		encoder.SetEscapeHTML(false)
		if format == "json" {
			encoder.SetIndent("", "  ")
		}
		return encoder.Encode(object)
	}
	return renderRows(w, []map[string]any{object}, Options{Format: format, Columns: columns, NoHeader: noHeader})
}

func renderRows(w io.Writer, items []map[string]any, options Options) error {
	columns := options.Columns
	if len(columns) == 0 {
		columns = []string{"id", "snippet.title"}
	}
	var target io.Writer = w
	var table *tabwriter.Writer
	if options.Format == "table" {
		table = tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		target = table
	} else {
		target = bufio.NewWriter(w)
	}
	if !options.NoHeader {
		for i, column := range columns {
			if i > 0 {
				fmt.Fprint(target, "\t")
			}
			fmt.Fprint(target, strings.ToUpper(column))
		}
		fmt.Fprintln(target)
	}
	for _, item := range items {
		for i, column := range columns {
			if i > 0 {
				fmt.Fprint(target, "\t")
			}
			fmt.Fprint(target, cell(pathValue(item, column)))
		}
		fmt.Fprintln(target)
	}
	if table != nil {
		return table.Flush()
	}
	if buffered, ok := target.(*bufio.Writer); ok {
		return buffered.Flush()
	}
	return nil
}

func pathValue(item map[string]any, path string) any {
	var value any = item
	for _, segment := range strings.Split(path, ".") {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[segment]
	}
	return value
}

func cell(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return clean(typed)
	case json.Number:
		return typed.String()
	case bool:
		return fmt.Sprint(typed)
	case []any:
		values := make([]string, 0, len(typed))
		for _, entry := range typed {
			values = append(values, cell(entry))
		}
		return strings.Join(values, ",")
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		values := make([]string, 0, len(keys))
		for _, key := range keys {
			values = append(values, key+"="+cell(typed[key]))
		}
		return strings.Join(values, ",")
	default:
		data, _ := json.Marshal(value)
		return string(data)
	}
}

func clean(value string) string {
	return strings.NewReplacer("\t", " ", "\r", " ", "\n", " ").Replace(value)
}
