import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

app.use(express.json());

// Health check route
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "NeonInsta API is alive" });
});

// API Route to fetch Instagram media
app.post(["/api/fetch-insta", "/fetch-insta"], async (req, res) => {
    let { url } = req.body;

    if (!url || !url.includes("instagram.com")) {
      return res.status(400).json({ error: "Invalid Instagram URL" });
    }

    // Normalize URL
    try {
      const urlObj = new URL(url);
      urlObj.search = ""; // Remove query parameters
      url = urlObj.toString();
    } catch (e) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    try {
      // Strategy 1: Standard Mobile Request
      const fetchInstagram = async (userAgent: string) => {
        return await axios.get(url, {
          headers: {
            "User-Agent": userAgent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Upgrade-Insecure-Requests": "1",
            "Referer": "https://www.google.com/",
          },
          maxRedirects: 5,
          timeout: 10000,
          validateStatus: (status) => status < 500,
        });
      };

      const userAgents = [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
        "Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
      ];

      let response;
      let html = "";
      
      // Try different user agents if blocked
      for (const ua of userAgents) {
        try {
          response = await fetchInstagram(ua);
          const finalUrl = response.request.res.responseUrl || url;
          if (!finalUrl.includes("accounts/login")) {
            html = response.data;
            if (html.includes("video_url") || html.includes("video_versions") || html.includes(".mp4")) {
              break;
            }
          }
        } catch (e) {}
      }

      // Strategy 2: GraphQL Fallback (if no video found yet)
      const shortcodeMatch = url.match(/\/(?:p|reels|reel)\/([A-Za-z0-9_-]+)/);
      const shortcode = shortcodeMatch ? shortcodeMatch[1] : null;

      if (shortcode && (!html || !html.includes(".mp4"))) {
        try {
          const gqlUrl = `https://www.instagram.com/graphql/query/?query_hash=b7d3d6544695990391a4f148fdd9c063&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
          const gqlResponse = await axios.get(gqlUrl, {
            headers: {
              "User-Agent": userAgents[0],
              "X-Requested-With": "XMLHttpRequest",
              "Referer": url,
            },
            timeout: 5000,
          });
          
          const media = gqlResponse.data?.data?.shortcode_media;
          if (media) {
            const videoUrl = media.video_url;
            const imageUrl = media.display_url;
            const title = media.edge_media_to_caption?.edges?.[0]?.node?.text || "Instagram Media";
            
            if (videoUrl) {
              return res.json({
                mediaUrl: videoUrl,
                title,
                type: "video",
                isReel: url.includes("/reel/") || url.includes("/reels/"),
                videoFound: true
              });
            }
          }
        } catch (e) {}
      }

      if (!html) {
        return res.status(403).json({ error: "Instagram is currently blocking our server. This happens because they protect their content aggressively. Please try again in 2-3 minutes." });
      }

      const $ = cheerio.load(html);
      let videoUrl: string | undefined;
      let imageUrl: string | undefined;
      let title = $('meta[property="og:title"]').attr("content") || "Instagram Media";

      // 1. OG Tags
      videoUrl = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:secure_url"]').attr("content");
      imageUrl = $('meta[property="og:image"]').attr("content");

      // 2. Aggressive JSON Extraction
      const jsonPatterns = [
        /"video_url":"([^"]+)"/,
        /"video_src":"([^"]+)"/,
        /"content_url":"([^"]+)"/,
        /video_versions.*?url":"([^"]+)"/,
        /"display_url":"([^"]+)"/,
        /"xdt_api__v1__media__direct_path":"([^"]+)"/,
        /"video_duration":.*?,"url":"([^"]+)"/,
        /"video_dash_manifest":"([^"]+)"/,
        /"video_url":"(https:\\\/\\\/[^"]+)"/,
        /https?:\/\/instagram\.[^"'\s<>]+?\.mp4[^"'\s<>]*/,
        /https?:\/\/scontent\.[^"'\s<>]+?\.mp4[^"'\s<>]*/,
        /https?:\/\/fbcdn\.[^"'\s<>]+?\.mp4[^"'\s<>]*/,
        /https?:\/\/cdninstagram\.[^"'\s<>]+?\.mp4[^"'\s<>]*/,
        /https?:\/\/scontent-.*?\.cdninstagram\.com\/[^"'\s<>]+?\.mp4[^"'\s<>]*/
      ];

      $("script").each((_, script) => {
        const content = $(script).html();
        if (!content) return;

        // Try to find any URL that looks like a video link in the script
        for (const pattern of jsonPatterns) {
          const matches = content.match(new RegExp(pattern, "g"));
          if (matches) {
            for (const match of matches) {
              const urlMatch = match.match(pattern);
              if (urlMatch && (urlMatch[1] || urlMatch[0])) {
                const rawUrl = urlMatch[1] || urlMatch[0];
                const decoded = rawUrl.replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
                if (decoded.startsWith("http")) {
                  // If we find a video-like URL, prioritize it
                  if ((decoded.includes(".mp4") || decoded.includes("video")) && !decoded.includes("preview")) {
                    videoUrl = decoded;
                  } else if (!imageUrl && !decoded.includes(".mp4")) {
                    imageUrl = decoded;
                  }
                }
              }
            }
          }
        }
        
        // Special check for Reels data structure
        if (!videoUrl && (content.includes("xdt_shortcode_media") || content.includes("graphql") || content.includes("video_versions"))) {
          try {
            // Try all video_versions in the script
            const videoVersionsMatches = content.match(/"video_versions":\[(.*?)\]/g);
            if (videoVersionsMatches) {
              for (const vMatch of videoVersionsMatches) {
                const urlMatches = vMatch.match(/"url":"([^"]+)"/g);
                if (urlMatches) {
                  // Pick the first one (usually highest quality)
                  const url = urlMatches[0].match(/"url":"([^"]+)"/)?.[1];
                  if (url) {
                    videoUrl = url.replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
                    break;
                  }
                }
              }
            }
            
            if (!videoUrl) {
              const videoMatch = content.match(/"video_url":"([^"]+)"/);
              if (videoMatch) {
                videoUrl = videoMatch[1].replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
              }
            }

            // Check for direct_path
            if (!videoUrl) {
              const directPathMatch = content.match(/"xdt_api__v1__media__direct_path":"([^"]+)"/);
              if (directPathMatch) {
                videoUrl = directPathMatch[1].replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
              }
            }
          } catch (e) {}
        }
      });

      // 3. Last Resort: Raw HTML Scan
      if (!videoUrl) {
        // Look for any MP4 or video link from Instagram or Facebook CDN
        const mp4Matches = html.match(/https?:\/\/[^"'\s<>]+?\.(mp4|m4v|mov)[^"'\s<>]*/g);
        if (mp4Matches) {
          for (const match of mp4Matches) {
            const decoded = match.replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
            // Check if it's a valid video URL from Instagram or FB CDN
            if (!decoded.includes("preview") && (decoded.includes("cdninstagram.com") || decoded.includes("fbcdn.net") || decoded.includes("instagram.com"))) {
              videoUrl = decoded;
              break;
            }
          }
        }
      }

      // 4. Check for display_resources (often contains high-res images/videos)
      if (!videoUrl && html.includes("display_resources")) {
        const resourceMatches = html.match(/"src":"([^"]+)"/g);
        if (resourceMatches) {
          for (const match of resourceMatches) {
            const src = match.match(/"src":"([^"]+)"/)?.[1];
            if (src && (src.includes(".mp4") || src.includes("video"))) {
              videoUrl = src.replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
              break;
            }
          }
        }
      }

      // 5. Check for direct video links in script tags (new pattern)
      if (!videoUrl) {
        $("script").each((_, script) => {
          const content = $(script).html();
          if (content && content.includes(".mp4")) {
            const matches = content.match(/"(https?:\/\/[^"]+?\.mp4[^"]*?)"/g);
            if (matches) {
              for (const match of matches) {
                const url = match.slice(1, -1).replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
                if (!url.includes("preview")) {
                  videoUrl = url;
                  break;
                }
              }
            }
          }
        });
      }

      // 6. Check for DASH manifest fallback
      if (!videoUrl && html.includes("video_dash_manifest")) {
        const manifestMatch = html.match(/"video_dash_manifest":"([^"]+)"/);
        if (manifestMatch) {
          const manifest = manifestMatch[1].replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
          // Try to find a direct MP4 link inside or near the manifest
          const baseMatch = manifest.match(/<BaseURL>(.*?)<\/BaseURL>/);
          if (baseMatch) {
            videoUrl = baseMatch[1];
          }
        }
      }

      // 7. Check for xdt_api__v1__media__direct_path in raw HTML
      if (!videoUrl && html.includes("xdt_api__v1__media__direct_path")) {
        const directPathMatch = html.match(/"xdt_api__v1__media__direct_path":"([^"]+)"/);
        if (directPathMatch) {
          videoUrl = directPathMatch[1].replace(/\\u0026/g, "&").replace(/\\/g, "").replace(/\\\//g, "/");
        }
      }

      const isReel = url.includes("/reel/") || url.includes("/reels/");
      const type = videoUrl ? "video" : "image";
      const finalMediaUrl = videoUrl || imageUrl;

      if (!finalMediaUrl) {
        return res.status(404).json({ error: "Media not found. The post might be private or the link is invalid." });
      }

      // If it's a reel but we only found an image, we should be honest about it in the background
      const isActuallyVideo = !!videoUrl;

      res.json({
        success: true,
        mediaUrl: finalMediaUrl,
        thumbnail: imageUrl || finalMediaUrl,
        title,
        type,
        isReel,
        videoFound: isActuallyVideo
      });
    } catch (error: any) {
      console.error("Fetch error:", error.message);
      res.status(500).json({ error: "Failed to connect to Instagram. Please try again." });
    }
  });

  // Proxy download endpoint to bypass CORS and force download
  app.get(["/api/download", "/download"], async (req, res) => {
    const { url, filename, type } = req.query;

    if (!url || typeof url !== "string") {
      return res.status(400).send("URL is required");
    }

    try {
      const response = await axios({
        method: "get",
        url: url,
        responseType: "stream",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Referer": "https://www.instagram.com/",
        },
        timeout: 20000,
      });

      const contentType = response.headers["content-type"];
      
      // Source of truth is the actual content-type from the media server
      let ext = "bin";
      let finalContentType = contentType || "application/octet-stream";

      if (contentType?.includes("video")) {
        ext = "mp4";
        finalContentType = "video/mp4";
      } else if (contentType?.includes("image/jpeg") || contentType?.includes("image/jpg")) {
        ext = "jpg";
        finalContentType = "image/jpeg";
      } else if (contentType?.includes("image/png")) {
        ext = "png";
        finalContentType = "image/png";
      } else if (contentType?.includes("image/webp")) {
        ext = "webp";
        finalContentType = "image/webp";
      } else {
        // Fallback logic if content-type is missing or generic
        const isVideo = url.includes(".mp4") || url.includes("video") || req.query.type === "video";
        if (isVideo) {
          ext = "mp4";
          finalContentType = "video/mp4";
        } else {
          ext = "jpg";
          finalContentType = "image/jpeg";
        }
      }

      const finalFilename = filename ? `${filename}.${ext}` : `neoninsta_${Date.now()}.${ext}`;

      res.setHeader("Content-Disposition", `attachment; filename="${finalFilename}"`);
      res.setHeader("Content-Type", finalContentType);

      response.data.pipe(res);
    } catch (error: any) {
      console.error("Download proxy error:", error.message);
      res.status(500).send("Failed to download file");
    }
  });

  // Vite middleware for development (AI Studio Preview)
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else if (process.env.NODE_ENV === "production" && !process.env.VERCEL) {
    // Serve static files in production mode (non-Vercel)
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  if (!process.env.VERCEL) {
    const PORT = Number(process.env.PORT) || 3000;
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  }

export default app;
