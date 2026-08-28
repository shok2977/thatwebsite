const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "TubeStream API",
      version: "2.0.0",
      description: "Video streaming API with instant playback, infinite scroll, and background prefetching",
    },
    servers: [{ url: "/", description: "Local server" }],
    components: {
      schemas: {
        Video: {
          type: "object",
          properties: {
            id: { type: "string", example: "abc123" },
            title: { type: "string", example: "Video Title" },
            pageUrl: { type: "string", example: "/videos/xyz-abc123" },
            thumb: { type: "string", example: "https://example.com/thumb.jpg" },
            duration: { type: "string", example: "12:34" },
            preview: { type: "string", description: "Preview video URL" },
            fallback: { type: "string", description: "Fallback video URL" },
            stream: { type: "string", description: "Stream URL" },
          },
        },
        VideosResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            page: { type: "integer" },
            category: { type: "string" },
            count: { type: "integer" },
            videos: { type: "array", items: { $ref: "#/components/schemas/Video" } },
          },
        },
        StreamUrlResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            m3u8Url: { type: "string", nullable: true },
            cached: { type: "boolean" },
          },
        },
        PrefetchRequest: {
          type: "object",
          required: ["urls"],
          properties: {
            urls: { type: "array", items: { type: "string" } },
          },
        },
        PrefetchResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            results: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  m3u8Url: { type: "string", nullable: true },
                  cached: { type: "boolean" },
                  error: { type: "string", nullable: true },
                },
              },
            },
          },
        },
        StatsResponse: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            uptime: { type: "integer" },
            mongodb: { type: "boolean" },
            cachedPages: { type: "integer" },
            cachedStreams: { type: "integer" },
            cachedSearches: { type: "integer" },
          },
        },
      },
    },
    paths: {
      "/api/videos": {
        get: {
          tags: ["Videos"],
          summary: "Get paginated video feed by category",
          parameters: [
            { name: "page", in: "query", schema: { type: "integer", default: 1 }, description: "Page number" },
            { name: "category", in: "query", schema: { type: "string", default: "newest" }, description: "Category: newest, hot, popular, top, hd, longest" },
          ],
          responses: {
            200: { description: "Video list", content: { "application/json": { schema: { $ref: "#/components/schemas/VideosResponse" } } } },
          },
        },
      },
      "/api/videos/{id}": {
        get: {
          tags: ["Videos"],
          summary: "Get single video by ID",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Video ID" },
          ],
          responses: {
            200: { description: "Video details" },
            404: { description: "Not found" },
          },
        },
      },
      "/api/search": {
        get: {
          tags: ["Search"],
          summary: "Search videos by keyword",
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Search keyword" },
            { name: "page", in: "query", schema: { type: "integer", default: 1 } },
          ],
          responses: {
            200: { description: "Search results", content: { "application/json": { schema: { $ref: "#/components/schemas/VideosResponse" } } } },
          },
        },
      },
      "/api/stream-url": {
        get: {
          tags: ["Streams"],
          summary: "Extract m3u8 stream URL from a video page",
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string" }, description: "Video page URL" },
          ],
          responses: {
            200: { description: "Stream URL", content: { "application/json": { schema: { $ref: "#/components/schemas/StreamUrlResponse" } } } },
          },
        },
      },
      "/api/prefetch": {
        post: {
          tags: ["Prefetch"],
          summary: "Batch prefetch m3u8 URLs in background",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/PrefetchRequest" } } },
          },
          responses: {
            200: { description: "Prefetch results", content: { "application/json": { schema: { $ref: "#/components/schemas/PrefetchResponse" } } } },
          },
        },
      },
      "/api/stream": {
        get: {
          tags: ["Streams"],
          summary: "Proxy video stream (CORS bypass + m3u8 rewrite)",
          parameters: [
            { name: "url", in: "query", required: true, schema: { type: "string" }, description: "Upstream stream URL" },
          ],
          responses: {
            200: { description: "Proxied stream content" },
          },
        },
      },
      "/api/categories": {
        get: {
          tags: ["Categories"],
          summary: "List available categories",
          responses: {
            200: { description: "Category list" },
          },
        },
      },
      "/api/stats": {
        get: {
          tags: ["System"],
          summary: "Server health and cache stats",
          responses: {
            200: { description: "Stats", content: { "application/json": { schema: { $ref: "#/components/schemas/StatsResponse" } } } },
          },
        },
      },
      "/api/refresh": {
        get: {
          tags: ["System"],
          summary: "Force refresh feed cache",
          responses: {
            200: { description: "Refresh result" },
          },
        },
      },
    },
  },
  apis: [],
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = swaggerSpec;
