package youtube

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

type PageOptions struct {
	All       bool
	Limit     int
	PageSize  int
	PageToken string
}

type ListResult struct {
	Items         []map[string]any `json:"items"`
	NextPageToken string           `json:"nextPageToken,omitempty"`
	Requests      int              `json:"requests"`
}

func (c *Client) List(ctx context.Context, resource string, params url.Values, options PageOptions) (ListResult, error) {
	if options.PageSize > 0 {
		params.Set("maxResults", fmt.Sprint(options.PageSize))
	}
	if options.PageToken != "" {
		params.Set("pageToken", options.PageToken)
	}
	result := ListResult{Items: make([]map[string]any, 0)}
	for {
		response, err := c.Get(ctx, resource, params)
		if err != nil {
			return result, err
		}
		result.Requests++
		items := response.Items
		if options.Limit > 0 && len(result.Items)+len(items) > options.Limit {
			items = items[:options.Limit-len(result.Items)]
		}
		result.Items = append(result.Items, items...)
		result.NextPageToken = response.NextPageToken
		if !options.All || response.NextPageToken == "" || (options.Limit > 0 && len(result.Items) >= options.Limit) {
			break
		}
		params.Set("pageToken", response.NextPageToken)
	}
	return result, nil
}

var channelIDPattern = regexp.MustCompile(`^UC[A-Za-z0-9_-]{22}$`)

func (c *Client) ResolveChannel(ctx context.Context, reference string) (string, int, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" {
		return "", 0, errors.New("channel reference cannot be empty")
	}
	if channelIDPattern.MatchString(reference) {
		return reference, 0, nil
	}

	kind, value := parseChannelReference(reference)
	params := url.Values{"part": {"id"}}
	switch kind {
	case "id":
		if !channelIDPattern.MatchString(value) {
			return "", 0, fmt.Errorf("invalid channel ID %q", value)
		}
		return value, 0, nil
	case "handle":
		params.Set("forHandle", strings.TrimPrefix(value, "@"))
	case "username":
		params.Set("forUsername", value)
	default:
		search := url.Values{"part": {"snippet"}, "type": {"channel"}, "q": {value}, "maxResults": {"1"}}
		response, err := c.Get(ctx, "search", search)
		if err != nil {
			return "", 1, err
		}
		if len(response.Items) == 0 {
			return "", 1, fmt.Errorf("channel %q not found", reference)
		}
		id, _ := nestedString(response.Items[0], "id", "channelId")
		if id == "" {
			return "", 1, fmt.Errorf("channel %q not found", reference)
		}
		return id, 1, nil
	}
	response, err := c.Get(ctx, "channels", params)
	if err != nil {
		return "", 1, err
	}
	if len(response.Items) == 0 {
		return "", 1, fmt.Errorf("channel %q not found", reference)
	}
	id, _ := response.Items[0]["id"].(string)
	if id == "" {
		return "", 1, fmt.Errorf("channel %q not found", reference)
	}
	return id, 1, nil
}

func parseChannelReference(reference string) (string, string) {
	if strings.HasPrefix(reference, "@") {
		return "handle", reference
	}
	candidate := reference
	if !strings.Contains(candidate, "://") && (strings.Contains(candidate, "youtube.com/") || strings.Contains(candidate, "youtu.be/")) {
		candidate = "https://" + candidate
	}
	if parsed, err := url.Parse(candidate); err == nil && parsed.Host != "" {
		host := strings.ToLower(strings.TrimPrefix(parsed.Hostname(), "www."))
		if host == "youtube.com" || host == "m.youtube.com" {
			parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
			if len(parts) > 0 && strings.HasPrefix(parts[0], "@") {
				return "handle", parts[0]
			}
			if len(parts) >= 2 {
				switch parts[0] {
				case "channel":
					return "id", parts[1]
				case "user":
					return "username", parts[1]
				case "c":
					return "search", parts[1]
				}
			}
		}
	}
	return "search", reference
}

func nestedString(value map[string]any, path ...string) (string, bool) {
	var current any = value
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return "", false
		}
		current, ok = object[key]
		if !ok {
			return "", false
		}
	}
	result, ok := current.(string)
	return result, ok
}
