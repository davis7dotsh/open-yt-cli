package ops

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"open-yt-cli/internal/youtube"
)

// Page is the shared Data API pagination input. Zero PageSize means the
// operation's default.
type Page struct {
	PageSize  int    `json:"pageSize,omitempty" jsonschema:"results per request"`
	PageToken string `json:"pageToken,omitempty" jsonschema:"resume from a previous nextPageToken"`
	All       bool   `json:"all,omitempty" jsonschema:"follow nextPageToken across pages"`
	Limit     int    `json:"limit,omitempty" jsonschema:"maximum items to return; 0 means no extra limit"`
}

// API trims Data API responses to the parts and fields the caller needs.
type API struct {
	Parts  string `json:"parts,omitempty" jsonschema:"comma-separated API resource parts"`
	Fields string `json:"fields,omitempty" jsonschema:"Google partial-response fields selector"`
}

func (p Page) validate(maxSize int) error {
	return firstError(
		invalidIf(p.PageSize < 1 || p.PageSize > maxSize, "pageSize must be between 1 and %d", maxSize),
		invalidIf(p.Limit < 0, "limit cannot be negative"),
	)
}

// list resolves a client and runs a paginated Data API list.
func list(ctx context.Context, data DataClient, resource string, params url.Values, page Page, filter func(map[string]any) bool) (youtube.ListResult, error) {
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	options := pageOptions(page)
	options.Filter = filter
	return client.List(ctx, resource, params, options)
}

func pageOptions(page Page) youtube.PageOptions {
	return youtube.PageOptions{All: page.All, Limit: page.Limit, PageSize: page.PageSize, PageToken: page.PageToken}
}

// getByIDs fetches resources by ID in batches and fails if any requested ID
// is missing. Item IDs are requested for that check and stripped again unless
// the caller's fields selected them.
func getByIDs(ctx context.Context, client *youtube.Client, resource string, ids []string, batchSize int, params url.Values, fields string) (youtube.ListResult, error) {
	result := youtube.ListResult{Items: make([]map[string]any, 0)}
	requestFields, preserveID := FieldsWithRequired(fields, "items/id")
	setValues(params, map[string]string{"fields": requestFields})
	for _, group := range batch(ids, batchSize) {
		params.Set("id", strings.Join(group, ","))
		response, err := client.Get(ctx, resource, params)
		if err != nil {
			return youtube.ListResult{}, err
		}
		result.Requests++
		result.Items = append(result.Items, response.Items...)
	}
	if err := validateRequestedItems(resource, ids, result.Items); err != nil {
		return youtube.ListResult{}, err
	}
	stripItemIDs(result.Items, preserveID)
	return result, nil
}

func stripItemIDs(items []map[string]any, preserve bool) {
	if preserve {
		return
	}
	for _, item := range items {
		delete(item, "id")
	}
}

func validateRequestedItems(resource string, requested []string, items []map[string]any) error {
	requestedSet := make(map[string]bool, len(requested))
	uniqueRequested := make([]string, 0, len(requested))
	for _, id := range requested {
		if !requestedSet[id] {
			requestedSet[id] = true
			uniqueRequested = append(uniqueRequested, id)
		}
	}

	returned := make(map[string]bool, len(items))
	for _, item := range items {
		if id, _ := item["id"].(string); id != "" {
			returned[id] = true
		}
	}
	if len(returned) == 0 && len(items) == len(uniqueRequested) {
		// fields may omit IDs, so equal cardinality is the strongest check
		// available without overriding the caller's partial-response selector.
		return nil
	}

	missing := make([]string, 0)
	if len(returned) > 0 {
		for _, id := range uniqueRequested {
			if !returned[id] {
				missing = append(missing, id)
			}
		}
	} else if len(items) < len(uniqueRequested) {
		missing = uniqueRequested
	}
	if len(missing) == 0 {
		return nil
	}
	return fmt.Errorf("%s not found: %s", resource, strings.Join(missing, ", "))
}

// firstError returns the first failed check.
func firstError(checks ...error) error {
	for _, err := range checks {
		if err != nil {
			return err
		}
	}
	return nil
}

// invalidIf returns an InputError when bad is true.
func invalidIf(bad bool, format string, args ...any) error {
	if !bad {
		return nil
	}
	return &InputError{Message: fmt.Sprintf(format, args...)}
}

func validateTimestamp(field, value string) error {
	if value == "" {
		return nil
	}
	_, err := time.Parse(time.RFC3339, value)
	return invalidIf(err != nil, "%s must be an RFC 3339 timestamp", field)
}

func validateCSVEnum(field, value string, allowed ...string) error {
	for _, entry := range strings.Split(value, ",") {
		trimmed := strings.TrimSpace(entry)
		if trimmed == "" {
			return &InputError{Message: fmt.Sprintf("%s cannot contain an empty value (choose from: %s)", field, strings.Join(allowed, ", "))}
		}
		if err := validateEnum(field, trimmed, allowed...); err != nil {
			return err
		}
	}
	return nil
}

func validateEnum(field, value string, allowed ...string) error {
	if value == "" {
		return nil
	}
	for _, candidate := range allowed {
		if value == candidate {
			return nil
		}
	}
	return &InputError{Message: fmt.Sprintf("%s must be one of: %s", field, strings.Join(allowed, ", "))}
}

func validateParts(parts string, forbidden ...string) error {
	for _, value := range strings.Split(parts, ",") {
		for _, blocked := range forbidden {
			if strings.TrimSpace(value) == blocked {
				return &InputError{Message: fmt.Sprintf("part %q requires owner/OAuth access and is not supported", blocked)}
			}
		}
	}
	return nil
}

func partsOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func setValues(values url.Values, entries map[string]string) {
	for key, value := range entries {
		if value != "" {
			values.Set(key, value)
		}
	}
}

func batch(values []string, size int) [][]string {
	var batches [][]string
	for len(values) > 0 {
		count := min(size, len(values))
		batches = append(batches, values[:count])
		values = values[count:]
	}
	return batches
}

func csvValues(value string) []string {
	var values []string
	for _, entry := range strings.Split(value, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			values = append(values, entry)
		}
	}
	return values
}

func mapPathString(item map[string]any, path ...string) (string, bool) {
	var value any = item
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return "", false
		}
		value, ok = object[key]
		if !ok {
			return "", false
		}
	}
	result, ok := value.(string)
	return result, ok
}
