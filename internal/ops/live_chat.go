package ops

import (
	"cmp"
	"context"
	"fmt"
	"net/url"
	"strings"

	"open-yt-cli/internal/youtube"
)

type LiveChatPageInput struct {
	Video            string `json:"video,omitempty" jsonschema:"live video ID, resolved to its active chat with one extra request"`
	ChatID           string `json:"chatId,omitempty" jsonschema:"live chat ID (liveChatId from a previous page)"`
	PageSize         int    `json:"pageSize,omitempty" jsonschema:"messages per request (200-2000, default 500)"`
	PageToken        string `json:"pageToken,omitempty" jsonschema:"resume from a previous nextPageToken"`
	Limit            int    `json:"limit,omitempty" jsonschema:"maximum messages to return; 0 means the whole page. A limit that drops messages also drops nextPageToken, so omit it when following the chat"`
	ProfileImageSize int    `json:"profileImageSize,omitempty" jsonschema:"author image size in pixels (16-720, default 88)"`
	API
}

// LiveChatResult is one page of live chat. NextPageToken is the next poll's
// resume point; OfflineAt set means the chat has ended.
type LiveChatResult struct {
	youtube.ListResult
	LiveChatID            string `json:"liveChatId"`
	PollingIntervalMillis int64  `json:"pollingIntervalMillis,omitempty"`
	OfflineAt             string `json:"offlineAt,omitempty"`
}

// LiveChatPage fetches one page of live chat messages by video or chat ID.
func LiveChatPage(ctx context.Context, data DataClient, in LiveChatPageInput) (LiveChatResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 500)
	in.ProfileImageSize = cmp.Or(in.ProfileImageSize, 88)
	if err := firstError(
		invalidIf((in.Video == "") == (in.ChatID == ""), "provide exactly one of video or chatId"),
		invalidIf(in.PageSize < 200 || in.PageSize > 2000, "pageSize must be between 200 and 2000"),
		invalidIf(in.ProfileImageSize < 16 || in.ProfileImageSize > 720, "profileImageSize must be between 16 and 720"),
		invalidIf(in.Limit < 0, "limit cannot be negative"),
	); err != nil {
		return LiveChatResult{}, err
	}
	client, err := data(ctx)
	if err != nil {
		return LiveChatResult{}, err
	}
	chatID, requests, err := liveChatID(ctx, client, in)
	if err != nil {
		return LiveChatResult{}, err
	}
	response, err := client.Get(ctx, "liveChat/messages", liveChatParams(chatID, in))
	if err != nil {
		return LiveChatResult{}, err
	}
	items := response.Items
	nextPageToken := response.NextPageToken
	if in.Limit > 0 && len(items) > in.Limit {
		items = items[:in.Limit]
		// The server token points past the entire fetched page. Returning
		// it after discarding messages would skip those messages on resume.
		nextPageToken = ""
	}
	return LiveChatResult{
		ListResult:            youtube.ListResult{Items: items, NextPageToken: nextPageToken, Requests: requests + 1},
		LiveChatID:            chatID,
		PollingIntervalMillis: response.PollingIntervalMillis,
		OfflineAt:             response.OfflineAt,
	}, nil
}

func liveChatID(ctx context.Context, client *youtube.Client, in LiveChatPageInput) (string, int, error) {
	if in.ChatID != "" {
		return in.ChatID, 0, nil
	}
	response, err := client.Get(ctx, "videos", url.Values{"part": {"liveStreamingDetails"}, "id": {in.Video}})
	if err != nil {
		return "", 1, err
	}
	if len(response.Items) == 0 {
		return "", 1, fmt.Errorf("video %q not found", in.Video)
	}
	resolved, ok := mapPathString(response.Items[0], "liveStreamingDetails", "activeLiveChatId")
	if !ok || strings.TrimSpace(resolved) == "" {
		return "", 1, fmt.Errorf("video %q has no active public live chat", in.Video)
	}
	return resolved, 1, nil
}

func liveChatParams(chatID string, in LiveChatPageInput) url.Values {
	params := url.Values{
		"part":             {partsOr(in.Parts, "snippet,authorDetails")},
		"liveChatId":       {chatID},
		"maxResults":       {fmt.Sprint(in.PageSize)},
		"profileImageSize": {fmt.Sprint(in.ProfileImageSize)},
	}
	fields := in.Fields
	for _, required := range []string{"nextPageToken", "pollingIntervalMillis", "offlineAt"} {
		fields, _ = FieldsWithRequired(fields, required)
	}
	setValues(params, map[string]string{"pageToken": in.PageToken, "fields": fields})
	return params
}
