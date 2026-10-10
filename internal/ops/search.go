package ops

import (
	"cmp"
	"context"
	"net/url"
	"strings"

	"open-yt-cli/internal/youtube"
)

type SearchInput struct {
	Query                     string `json:"query,omitempty" jsonschema:"free-text query"`
	Type                      string `json:"type,omitempty" jsonschema:"comma-separated video, channel, and/or playlist (default all three)"`
	Channel                   string `json:"channel,omitempty" jsonschema:"only resources created by this channel ID"`
	ChannelType               string `json:"channelType,omitempty" jsonschema:"any or show (requires type channel)"`
	Order                     string `json:"order,omitempty" jsonschema:"date, rating, relevance (default), title, videoCount, or viewCount"`
	PublishedAfter            string `json:"publishedAfter,omitempty" jsonschema:"RFC 3339 lower publication bound"`
	PublishedBefore           string `json:"publishedBefore,omitempty" jsonschema:"RFC 3339 upper publication bound"`
	Region                    string `json:"region,omitempty" jsonschema:"ISO 3166-1 alpha-2 region code"`
	Language                  string `json:"language,omitempty" jsonschema:"relevance language code"`
	SafeSearch                string `json:"safeSearch,omitempty" jsonschema:"moderate (default), none, or strict"`
	EventType                 string `json:"eventType,omitempty" jsonschema:"completed, live, or upcoming (video searches)"`
	Location                  string `json:"location,omitempty" jsonschema:"latitude,longitude for a geographic video search"`
	LocationRadius            string `json:"locationRadius,omitempty" jsonschema:"radius such as 5km (requires location)"`
	Topic                     string `json:"topic,omitempty" jsonschema:"Freebase topic ID"`
	VideoCaption              string `json:"videoCaption,omitempty" jsonschema:"any, closedCaption, or none"`
	VideoCategory             string `json:"videoCategory,omitempty" jsonschema:"video category ID"`
	VideoDuration             string `json:"videoDuration,omitempty" jsonschema:"any, short, medium, or long"`
	VideoEmbeddable           string `json:"videoEmbeddable,omitempty" jsonschema:"any or true"`
	VideoLicense              string `json:"videoLicense,omitempty" jsonschema:"any, creativeCommon, or youtube"`
	VideoPaidProductPlacement string `json:"videoPaidProductPlacement,omitempty" jsonschema:"any or true"`
	VideoSyndicated           string `json:"videoSyndicated,omitempty" jsonschema:"any or true"`
	Page
	API
}

func Search(ctx context.Context, data DataClient, in SearchInput) (youtube.ListResult, error) {
	in.PageSize = cmp.Or(in.PageSize, 25)
	in.Order = cmp.Or(in.Order, "relevance")
	in.SafeSearch = cmp.Or(in.SafeSearch, "moderate")
	in.Type = cmp.Or(in.Type, "video,channel,playlist")
	videoFilter := in.EventType != "" || in.Location != "" || in.VideoCaption != "" || in.VideoCategory != "" || in.VideoDuration != "" || in.VideoEmbeddable != "" || in.VideoLicense != "" || in.VideoPaidProductPlacement != "" || in.VideoSyndicated != ""
	if err := firstError(
		in.Page.validate(50),
		validateEnum("order", in.Order, "date", "rating", "relevance", "title", "videoCount", "viewCount"),
		validateEnum("safeSearch", in.SafeSearch, "moderate", "none", "strict"),
		validateCSVEnum("type", in.Type, "video", "channel", "playlist"),
		validateEnum("channelType", in.ChannelType, "any", "show"),
		validateEnum("eventType", in.EventType, "completed", "live", "upcoming"),
		validateEnum("videoCaption", in.VideoCaption, "any", "closedCaption", "none"),
		validateEnum("videoDuration", in.VideoDuration, "any", "short", "medium", "long"),
		validateEnum("videoEmbeddable", in.VideoEmbeddable, "any", "true"),
		validateEnum("videoLicense", in.VideoLicense, "any", "creativeCommon", "youtube"),
		validateEnum("videoPaidProductPlacement", in.VideoPaidProductPlacement, "any", "true"),
		validateEnum("videoSyndicated", in.VideoSyndicated, "any", "true"),
		validateTimestamp("publishedAfter", in.PublishedAfter),
		validateTimestamp("publishedBefore", in.PublishedBefore),
		invalidIf((in.Location == "") != (in.LocationRadius == ""), "location and locationRadius must be used together"),
		invalidIf(videoFilter && in.Type != "video", "video-specific filters require type video"),
		invalidIf(in.ChannelType != "" && in.Type != "channel", "channelType requires type channel"),
	); err != nil {
		return youtube.ListResult{}, err
	}
	params := url.Values{"part": {partsOr(in.Parts, "snippet")}}
	requestFields, preserveKind := FieldsWithRequired(in.Fields, "items/id/kind")
	setValues(params, map[string]string{"q": in.Query, "channelId": in.Channel, "channelType": in.ChannelType, "order": in.Order, "publishedAfter": in.PublishedAfter, "publishedBefore": in.PublishedBefore, "regionCode": in.Region, "relevanceLanguage": in.Language, "safeSearch": in.SafeSearch, "type": in.Type, "eventType": in.EventType, "location": in.Location, "locationRadius": in.LocationRadius, "topicId": in.Topic, "videoCaption": in.VideoCaption, "videoCategoryId": in.VideoCategory, "videoDuration": in.VideoDuration, "videoEmbeddable": in.VideoEmbeddable, "videoLicense": in.VideoLicense, "videoPaidProductPlacement": in.VideoPaidProductPlacement, "videoSyndicated": in.VideoSyndicated, "fields": requestFields})
	return list(ctx, data, "search", params, in.Page, searchResultFilter(in.Type, preserveKind))
}

// searchResultFilter drops results of kinds the caller did not ask for, and
// strips the internally requested id.kind unless the caller selected it.
func searchResultFilter(resourceTypes string, preserveKind bool) func(map[string]any) bool {
	allowed := make(map[string]bool)
	for _, resourceType := range strings.Split(resourceTypes, ",") {
		allowed[strings.TrimSpace(resourceType)] = true
	}
	return func(item map[string]any) bool {
		id, _ := item["id"].(map[string]any)
		if kind, _ := id["kind"].(string); strings.HasPrefix(kind, "youtube#") {
			accepted := allowed[strings.TrimPrefix(kind, "youtube#")]
			if accepted && !preserveKind {
				delete(id, "kind")
				if len(id) == 0 {
					delete(item, "id")
				}
			}
			return accepted
		}
		return false
	}
}
