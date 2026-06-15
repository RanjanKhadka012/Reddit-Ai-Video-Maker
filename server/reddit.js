const REDDIT_BASE = "https://www.reddit.com";
const OLD_REDDIT_BASE = "https://old.reddit.com";
const REDDIT_API_BASE = "https://api.reddit.com";
const REDDIT_OAUTH_BASE = "https://oauth.reddit.com";

const cleanText = (value = "") =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const decodeHtml = (value = "") =>
  cleanText(
    value
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number.parseInt(number, 10)))
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
  );

const stripTags = (html = "") =>
  decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );

export function buildScript(post, targetMinutes = 10) {
  const title = cleanText(post.title);
  const body = cleanText(post.selftext || "");
  const raw = `${title}. ${body}`.trim();
  const targetWords = Math.round(targetMinutes * 145);
  const words = raw.split(/\s+/).filter(Boolean);
  const clipped = words.slice(0, targetWords).join(" ");
  return clipped.length > 0 ? clipped : title;
}

async function getAccessToken({ clientId, clientSecret, userAgent }) {
  if (!clientId || !clientSecret) return null;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${REDDIT_BASE}/api/v1/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent
    },
    body: new URLSearchParams({ grant_type: "client_credentials" })
  });

  if (!response.ok) {
    throw new Error(`Reddit OAuth returned ${response.status}. Check REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET.`);
  }

  const payload = await response.json();
  return payload.access_token;
}

async function redditGet({ path, params, userAgent, accessToken }) {
  const query = params.toString();
  const headers = {
    Accept: "application/json",
    "User-Agent": userAgent
  };

  if (accessToken) {
    const response = await fetch(`${REDDIT_OAUTH_BASE}${path}?${query}`, {
      headers: {
        ...headers,
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (response.ok) return response;
  }

  let response = await fetch(`${REDDIT_BASE}${path}.json?${query}`, { headers });

  if (response.status === 403 || response.status === 429) {
    response = await fetch(`${REDDIT_API_BASE}${path}?${query}`, { headers });
  }

  return response;
}

async function fetchTopCommentStories({ post, userAgent, accessToken }) {
  const params = "limit=12&sort=top&raw_json=1";
  const response = await redditGet({
    path: post.permalink.replace(/\/$/, ""),
    params: new URLSearchParams(params),
    userAgent,
    accessToken
  });

  if (!response.ok) return [];

  const json = await response.json();
  const comments = json?.[1]?.data?.children || [];

  return comments
    .map((child) => child.data)
    .filter((comment) => comment?.body && !comment.stickied && comment.body !== "[deleted]")
    .map((comment) => {
      const body = cleanText(comment.body);
      const words = body.split(/\s+/).filter(Boolean);
      if (words.length < 160) return null;
      const script = buildScript({ title: post.title, selftext: body });
      return {
        id: `${post.id}-${comment.id}`,
        title: cleanText(post.title),
        author: comment.author,
        score: comment.score,
        comments: post.num_comments,
        subreddit: post.subreddit,
        permalink: `${REDDIT_BASE}${post.permalink}`,
        selftext: body,
        script,
        estimatedSeconds: Math.max(30, Math.round((script.split(/\s+/).length / 145) * 60)),
        source: "top-comment"
      };
    })
    .filter(Boolean);
}

async function fetchOldRedditHtml(path, userAgent) {
  const response = await fetch(`${OLD_REDDIT_BASE}${path}`, {
    headers: {
      Accept: "text/html",
      "User-Agent": userAgent || "RedditVideoMaker/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`old.reddit returned ${response.status}.`);
  }

  return response.text();
}

function parseOldRedditListing(html, subreddit, count) {
  const posts = [];
  const blocks = html.match(/<div class=" thing id-t3_[\s\S]*?(?=<div class=" thing id-t3_|<div class="nav-buttons"|$)/g) || [];

  for (const block of blocks) {
    if (/data-nsfw="true"/.test(block) || /promotedlink/.test(block)) continue;

    const titleMatch = block.match(/<a class="title[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const idMatch = block.match(/data-fullname="t3_([^"]+)"/);
    if (!titleMatch || !idMatch) continue;

    const permalinkMatch = block.match(/data-permalink="([^"]+)"/);
    const scoreMatch = block.match(/data-score="(\d+)"/);
    const commentsMatch = block.match(/data-comments-count="(\d+)"/);

    posts.push({
      id: idMatch[1],
      title: stripTags(titleMatch[2]),
      permalink: decodeHtml(permalinkMatch?.[1] || titleMatch[1]),
      score: Number(scoreMatch?.[1] || 0),
      num_comments: Number(commentsMatch?.[1] || 0),
      subreddit,
      selftext: ""
    });

    if (posts.length >= count) break;
  }

  return posts;
}

function parseOldRedditComments(html, post, count) {
  const comments = [];
  const blocks = html.match(/thing id-t1_[\s\S]*?(?=thing id-t1_|<div class="morechildren"|$)/g) || [];

  for (const block of blocks) {
    const idMatch = block.match(/data-fullname="t1_([^"]+)"/);
    const authorMatch = block.match(/data-author="([^"]+)"/);
    const scoreMatch = block.match(/itemprop="upvoteCount">(\d+)</);
    const bodyMatch = block.match(/usertext-body[\s\S]*?<div class="md">([\s\S]*?)<\/div>\s*<\/div>/);
    if (!idMatch || !bodyMatch) continue;

    const body = stripTags(bodyMatch[1]);
    const words = body.split(/\s+/).filter(Boolean);
    if (words.length < 80) continue;

    const script = buildScript({ title: post.title, selftext: body });
    comments.push({
      id: `${post.id}-${idMatch[1]}`,
      title: post.title,
      author: decodeHtml(authorMatch?.[1] || "old-reddit"),
      score: Number(scoreMatch?.[1] || 0),
      comments: post.num_comments,
      subreddit: post.subreddit,
      permalink: `${REDDIT_BASE}${post.permalink}`,
      selftext: body,
      script,
      estimatedSeconds: Math.max(30, Math.round((script.split(/\s+/).length / 145) * 60)),
      source: "old-reddit-comment"
    });

    if (comments.length >= count) break;
  }

  return comments;
}

async function fetchStoriesFromOldReddit({ subreddit, sort, time, limit, userAgent }) {
  const safeSort = ["hot", "new", "top", "rising"].includes(sort) ? sort : "top";
  const count = Math.min(Math.max(Number(limit) || 12, 1), 25);
  const timeQuery = safeSort === "top" ? `?sort=top&t=${time}` : "";
  const listingHtml = await fetchOldRedditHtml(`/r/${subreddit}/${safeSort}/${timeQuery}`, userAgent);
  const posts = parseOldRedditListing(listingHtml, subreddit, count);
  const stories = [];

  for (const post of posts) {
    if (stories.length >= count) break;

    try {
      const commentsHtml = await fetchOldRedditHtml(`${post.permalink}?sort=top`, userAgent);
      stories.push(...parseOldRedditComments(commentsHtml, post, Math.max(1, count - stories.length)));
    } catch {
      const script = buildScript(post);
      stories.push({
        id: post.id,
        title: post.title,
        author: "old-reddit",
        score: post.score,
        comments: post.num_comments,
        subreddit: post.subreddit,
        permalink: `${REDDIT_BASE}${post.permalink}`,
        selftext: post.selftext,
        script,
        estimatedSeconds: Math.max(30, Math.round((script.split(/\s+/).length / 145) * 60)),
        source: "old-reddit-post"
      });
    }
  }

  return stories
    .filter((post) => post.script.split(/\s+/).length >= 80)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

export async function fetchStories({ subreddit, sort, time, limit, userAgent, clientId, clientSecret }) {
  const safeSubreddit = subreddit.replace(/^r\//i, "").replace(/[^a-z0-9_]/gi, "");
  const safeSort = ["hot", "new", "top", "rising"].includes(sort) ? sort : "top";
  const safeTime = ["hour", "day", "week", "month", "year", "all"].includes(time) ? time : "day";
  const count = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const params = new URLSearchParams({ limit: String(count), raw_json: "1" });

  if (safeSort === "top") params.set("t", safeTime);

  const accessToken = await getAccessToken({ clientId, clientSecret, userAgent });
  const listingPath = `/r/${safeSubreddit}/${safeSort}`;
  const response = await redditGet({
    path: listingPath,
    params,
    userAgent,
    accessToken
  });

  if (!response.ok) {
    const fallbackStories = await fetchStoriesFromOldReddit({
      subreddit: safeSubreddit,
      sort: safeSort,
      time: safeTime,
      limit: count,
      userAgent
    });

    if (fallbackStories.length > 0) return fallbackStories;

    throw new Error(
      `Reddit returned ${response.status} for r/${safeSubreddit}. Add Reddit OAuth credentials in .env or paste a story manually.`
    );
  }

  const json = await response.json();
  const children = json?.data?.children || [];

  const posts = children
    .map((child) => child.data)
    .filter((post) => post && !post.stickied && !post.over_18 && post.is_self);

  const stories = [];

  for (const post of posts) {
    const bodyWords = cleanText(post.selftext || "").split(/\s+/).filter(Boolean).length;

    if (bodyWords >= 160) {
      const script = buildScript(post);
      stories.push({
        id: post.id,
        title: cleanText(post.title),
        author: post.author,
        score: post.score,
        comments: post.num_comments,
        subreddit: post.subreddit,
        permalink: `${REDDIT_BASE}${post.permalink}`,
        selftext: cleanText(post.selftext || ""),
        script,
        estimatedSeconds: Math.max(30, Math.round((script.split(/\s+/).length / 145) * 60)),
        source: "post"
      });
    } else if (stories.length < count) {
      stories.push(...(await fetchTopCommentStories({ post, userAgent, accessToken })));
    }
  }

  return stories
    .filter((post) => post.script.split(/\s+/).length >= 160)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}
