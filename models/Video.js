const mongoose = require("mongoose");

const videoSchema = new mongoose.Schema(
  {
    videoId: { type: String, required: true, unique: true, index: true },
    title: { type: String, default: "" },
    pageUrl: { type: String, required: true, index: true },
    category: { type: String, default: "newest", index: true },
    thumb: { type: String, default: "" },
    duration: { type: String, default: "" },
    preview: { type: String, default: "" },
    fallback: { type: String, default: "" },
    stream: { type: String, default: "" },
    m3u8Url: { type: String, default: null },
    m3u8FetchedAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

videoSchema.index({ category: 1, createdAt: -1 });
videoSchema.index({ title: "text" });

module.exports = mongoose.model("Video", videoSchema);
