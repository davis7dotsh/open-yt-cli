package ops

import (
	"cmp"
	"context"
	"net/url"

	"open-yt-cli/internal/youtube"
)

type PlaylistGetInput struct {
	IDs []string `json:"ids" jsonschema:"playlist IDs; up to 50 cost one request"`
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func PlaylistGet(ctx context.Context, data DataClient, in PlaylistGetInput) (youtube.ListResult, error) {
	if len(in.IDs) == 0 {
		return youtube.ListResult{}, &InputError{Message: "ids must contain at least one playlist ID"}
	}
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet,contentDetails,status")}}
	setValues(params, map[string]string{"hl": in.HL})
	return getByIDs(ctx, client, "playlists", in.IDs, 50, params, in.Fields)
}

type PlaylistListInput struct {
	Channel string `json:"channel" jsonschema:"channel ID"`
	Page
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func PlaylistList(ctx context.Context, data DataClient, in PlaylistListInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 25)
	if err := firstError(
		in.Page.validate(50),
		invalidIf(in.Channel == "", "channel is required"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet,contentDetails,status")}, "channelId": {in.Channel}}
	setValues(params, map[string]string{"hl": in.HL, "fields": in.Fields})
	return list(ctx, data, "playlists", params, in.Page, nil)
}

type PlaylistItemsInput struct {
	Playlist string `json:"playlist" jsonschema:"playlist ID"`
	Video    string `json:"video,omitempty" jsonschema:"only items for this video ID"`
	Page
	API
}

func PlaylistItems(ctx context.Context, data DataClient, in PlaylistItemsInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 50)
	if err := in.Page.validate(50); err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet,contentDetails,status")}, "playlistId": {in.Playlist}}
	setValues(params, map[string]string{"videoId": in.Video, "fields": in.Fields})
	return list(ctx, data, "playlistItems", params, in.Page, nil)
}

type CommentGetInput struct {
	IDs        []string `json:"ids" jsonschema:"comment IDs; up to 100 cost one request"`
	TextFormat string   `json:"textFormat,omitempty" jsonschema:"plainText (default) or html"`
	API
}

func CommentGet(ctx context.Context, data DataClient, in CommentGetInput) (youtube.ListResult, error) {
	in.TextFormat = cmp.Or(in.TextFormat, "plainText")
	if err := firstError(
		invalidIf(len(in.IDs) == 0, "ids must contain at least one comment ID"),
		validateEnum("textFormat", in.TextFormat, "plainText", "html"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	client, err := data(ctx)
	if err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet")}, "textFormat": {in.TextFormat}}
	return getByIDs(ctx, client, "comments", in.IDs, 100, params, in.Fields)
}

type CommentRepliesInput struct {
	Parent     string `json:"parent" jsonschema:"parent (top-level) comment ID"`
	TextFormat string `json:"textFormat,omitempty" jsonschema:"plainText (default) or html"`
	Page
	API
}

func CommentReplies(ctx context.Context, data DataClient, in CommentRepliesInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 20)
	in.TextFormat = cmp.Or(in.TextFormat, "plainText")
	if err := firstError(
		in.Page.validate(100),
		validateEnum("textFormat", in.TextFormat, "plainText", "html"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet")}, "parentId": {in.Parent}, "textFormat": {in.TextFormat}}
	setValues(params, map[string]string{"fields": in.Fields})
	return list(ctx, data, "comments", params, in.Page, nil)
}

type CommentThreadsInput struct {
	Video      string `json:"video,omitempty" jsonschema:"video ID"`
	Channel    string `json:"channel,omitempty" jsonschema:"channel ID (all threads related to the channel)"`
	ID         string `json:"id,omitempty" jsonschema:"comma-separated thread IDs"`
	Order      string `json:"order,omitempty" jsonschema:"time (default) or relevance"`
	Search     string `json:"search,omitempty" jsonschema:"restrict to comments containing these terms"`
	TextFormat string `json:"textFormat,omitempty" jsonschema:"plainText (default) or html"`
	Page
	API
}

func CommentThreads(ctx context.Context, data DataClient, in CommentThreadsInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 20)
	in.Order = cmp.Or(in.Order, "time")
	in.TextFormat = cmp.Or(in.TextFormat, "plainText")
	if err := firstError(
		in.Page.validate(100),
		validateEnum("textFormat", in.TextFormat, "plainText", "html"),
		validateEnum("order", in.Order, "time", "relevance"),
		invalidIf(countSet(in.Video, in.Channel, in.ID) != 1, "provide exactly one of video, channel, or id"),
		invalidIf(in.ID != "" && (in.Order != "time" || in.Search != ""), "order and search are incompatible with id"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet,replies")}}
	setValues(params, map[string]string{"videoId": in.Video, "allThreadsRelatedToChannelId": in.Channel, "id": in.ID, "order": in.Order, "searchTerms": in.Search, "textFormat": in.TextFormat, "fields": in.Fields})
	return list(ctx, data, "commentThreads", params, in.Page, nil)
}

type SubscriptionListInput struct {
	Channel    string `json:"channel,omitempty" jsonschema:"subscriber channel ID"`
	ID         string `json:"id,omitempty" jsonschema:"comma-separated subscription IDs"`
	Order      string `json:"order,omitempty" jsonschema:"alphabetical or relevance (default)"`
	ForChannel string `json:"forChannel,omitempty" jsonschema:"only subscriptions to this channel ID"`
	Page
	API
}

func SubscriptionList(ctx context.Context, data DataClient, in SubscriptionListInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 25)
	in.Order = cmp.Or(in.Order, "relevance")
	parts := partsOr(in.Parts, "snippet,contentDetails")
	if err := firstError(
		in.Page.validate(50),
		validateParts(parts, "subscriberSnippet"),
		validateEnum("order", in.Order, "alphabetical", "relevance"),
		invalidIf(countSet(in.Channel, in.ID) != 1, "provide exactly one of channel or id"),
		invalidIf(in.ID != "" && (in.ForChannel != "" || in.Order != "relevance"), "forChannel and order are incompatible with id"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {parts}}
	setValues(params, map[string]string{"channelId": in.Channel, "id": in.ID, "order": in.Order, "forChannelId": in.ForChannel, "fields": in.Fields})
	return list(ctx, data, "subscriptions", params, in.Page, nil)
}

type CategoryListInput struct {
	Region string `json:"region,omitempty" jsonschema:"ISO 3166-1 alpha-2 region code"`
	ID     string `json:"id,omitempty" jsonschema:"comma-separated category IDs"`
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func CategoryList(ctx context.Context, data DataClient, in CategoryListInput) (youtube.ListResult, error) {
	if countSet(in.Region, in.ID) != 1 {
		return youtube.ListResult{}, &InputError{Message: "provide exactly one of region or id"}
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet")}}
	setValues(params, map[string]string{"regionCode": in.Region, "id": in.ID, "hl": in.HL, "fields": in.Fields})
	return list(ctx, data, "videoCategories", params, Page{}, nil)
}

// I18nListInput is the input for LanguageList and RegionList.
type I18nListInput struct {
	API
	HL string `json:"hl,omitempty" jsonschema:"localization language code"`
}

func LanguageList(ctx context.Context, data DataClient, in I18nListInput) (youtube.ListResult, error) {
	return i18nList(ctx, data, "i18nLanguages", in)
}

func RegionList(ctx context.Context, data DataClient, in I18nListInput) (youtube.ListResult, error) {
	return i18nList(ctx, data, "i18nRegions", in)
}

func i18nList(ctx context.Context, data DataClient, resource string, in I18nListInput) (youtube.ListResult, error) {
	params := url.Values{"part": {partsOr(in.Parts, "snippet")}}
	setValues(params, map[string]string{"hl": in.HL, "fields": in.Fields})
	return list(ctx, data, resource, params, Page{}, nil)
}

func countSet(values ...string) int {
	count := 0
	for _, value := range values {
		if value != "" {
			count++
		}
	}
	return count
}
