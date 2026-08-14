module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { passcode, content } = req.body || {};

  if (!process.env.ADMIN_PASSCODE) {
    res.status(500).json({ error: "Server is not configured: ADMIN_PASSCODE is not set" });
    return;
  }
  if (!passcode || passcode !== process.env.ADMIN_PASSCODE) {
    res.status(401).json({ error: "Incorrect passcode" });
    return;
  }
  if (!content || typeof content !== "object") {
    res.status(400).json({ error: "Missing content" });
    return;
  }

  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    res.status(500).json({ error: "Server is not configured: GITHUB_OWNER, GITHUB_REPO, or GITHUB_TOKEN is missing" });
    return;
  }

  const ghHeaders = {
    Authorization: "Bearer " + token,
    Accept: "application/vnd.github+json",
    "User-Agent": "navya-hospital-admin",
  };

  async function getFileSha(path) {
    const r = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${branch}`,
      { headers: ghHeaders }
    );
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Failed to read ${path}: ${r.status}`);
    const j = await r.json();
    return j.sha;
  }

  async function putFile(path, base64Content, message) {
    const sha = await getFileSha(path);
    const body = { message, content: base64Content, branch };
    if (sha) body.sha = sha;
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
      method: "PUT",
      headers: { ...ghHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`GitHub write failed for ${path}: ${r.status} ${t}`);
    }
    return r.json();
  }

  // Walk the content tree and replace any embedded data:image/... URI with an
  // uploaded image file path, so content.json only ever stores small strings.
  async function extractImages(node, pathTrail) {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        await extractImages(node[i], pathTrail.concat(i));
      }
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const val = node[key];
        if (typeof val === "string" && val.startsWith("data:image/")) {
          const match = val.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const ext = match[1] === "jpeg" ? "jpg" : match[1];
            const base64 = match[2];
            const slug = pathTrail.concat(key).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") || "image";
            const filename = `images/${slug}-${Date.now()}.${ext}`;
            await putFile(filename, base64, `Update image: ${filename}`);
            node[key] = filename;
          }
        } else {
          await extractImages(val, pathTrail.concat(key));
        }
      }
    }
  }

  try {
    await extractImages(content, []);
    const jsonStr = JSON.stringify(content, null, 2) + "\n";
    const base64Json = Buffer.from(jsonStr, "utf-8").toString("base64");
    await putFile("content.json", base64Json, "Update site content via admin panel");
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
