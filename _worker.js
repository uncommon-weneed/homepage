export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // [설정 API] Daily Grace (오늘의 말씀)
    if (url.pathname === "/api/settings/daily-grace" && request.method === "GET") {
      try {
        const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'daily_grace'").first();
        return Response.json({ text: row ? row.value : "오순절 성령의 강력한 역사,\n말씀이 살아 숨 쉬는 교회" });
      } catch (e) {
        return Response.json({ text: "오순절 성령의 강력한 역사,\n말씀이 살아 숨 쉬는 교회" });
      }
    }
    if (url.pathname === "/api/settings/daily-grace" && request.method === "POST") {
      try {
        const { text } = await request.json();
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES ('daily_grace', ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(text.trim(), text.trim()).run();
        return Response.json({ success: true });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // [인증 API] 회원가입 & 로그인
    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { username, password, fullName } = await request.json();
        const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(username).first();
        if (existing) return new Response(JSON.stringify({ error: "이미 사용 중인 아이디입니다." }), { status: 400 });

        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        await env.DB.prepare("INSERT INTO users (username, password, full_name, status) VALUES (?, ?, ?, 'pending')").bind(username, hashedPassword, fullName).run();
        return Response.json({ success: true });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const { username, password } = await request.json();
        if (username === "admin" && password === "admin") {
          return Response.json({ success: true, username: "admin", fullName: "총괄관리자", isAdmin: true, status: "approved" });
        }
        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(username, hashedPassword).first();
        if (!user) return new Response(JSON.stringify({ error: "아이디 또는 비밀번호 불일치" }), { status: 401 });
        if (user.status !== "approved") return new Response(JSON.stringify({ error: "승인 대기 중입니다." }), { status: 403 });

        return Response.json({ success: true, id: user.id, username: user.username, fullName: user.full_name, isAdmin: false, status: user.status });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // [관리자 API]
    if (url.pathname === "/api/admin/users" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, username, full_name, status FROM users ORDER BY id DESC").all();
      return Response.json(results || []);
    }
    if (url.pathname === "/api/admin/action" && request.method === "POST") {
      const { id, action } = await request.json();
      if (action === "approve") await env.DB.prepare("UPDATE users SET status = 'approved' WHERE id = ?").bind(id).run();
      else if (action === "reject" || action === "delete") await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();
      else if (action === "reset_pw") {
        const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("0000"));
        const hashed0000 = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
        await env.DB.prepare("UPDATE users SET password = ? WHERE id = ?").bind(hashed0000, id).run();
      }
      return Response.json({ success: true });
    }
    if (url.pathname === "/api/admin/posts/delete" && request.method === "POST") {
      const { id } = await request.json();
      const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
      if (post && post.image_url) { try { await env.BUCKET.delete(post.image_url.replace("/api/images/", "")); } catch (err) {} }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // [게시글 API]
    if (url.pathname === "/api/posts" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
      return Response.json(results || []);
    }
    if (url.pathname === "/api/posts" && request.method === "POST") {
      const formData = await request.formData();
      const author = formData.get("author") || "익명"; const username = formData.get("username") || "";
      const title = formData.get("title") || "제목 없음"; const category = formData.get("category") || "일반나눔";
      const content = formData.get("content") || ""; const image = formData.get("image");
      let imageUrl = "";
      if (image && typeof image === "object" && image.size > 0 && image.name) {
        const ext = image.name.split(".").pop(); const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type || "image/jpeg" } });
        imageUrl = `/api/images/${fileName}`;
      }
      await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)").bind(`${author}|${username}|${title}|${category}`, content, imageUrl).run();
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/api/posts" && request.method === "PUT") {
      // 🐛 버그 수정 완료: authorMeta, title, category를 분리해서 받아 정상적인 순서로 조합합니다.
      const formData = await request.formData();
      const id = formData.get("id"); 
      const content = formData.get("content") || ""; 
      const title = formData.get("title") || "제목 없음";
      const category = formData.get("category") || "일반나눔";
      const authorMeta = formData.get("authorMeta"); // "이름|아이디"
      const keepImage = formData.get("keepImage") || ""; 
      const image = formData.get("image");
      
      let imageUrl = keepImage;
      if (image && typeof image === "object" && image.size > 0 && image.name) {
        const ext = image.name.split(".").pop(); const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type || "image/jpeg" } });
        imageUrl = `/api/images/${fileName}`;
      }
      await env.DB.prepare("UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?").bind(`${authorMeta}|${title}|${category}`, content, imageUrl, id).run();
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      const { id } = await request.json();
      const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
      if (post && post.image_url) { try { await env.BUCKET.delete(post.image_url.replace("/api/images/", "")); } catch (err) {} }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // [댓글 API]
    if (url.pathname === "/api/comments" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM comments ORDER BY id ASC").all();
      return Response.json(results || []);
    }
    if (url.pathname === "/api/comments" && request.method === "POST") {
      const { postId, author, content } = await request.json();
      await env.DB.prepare("INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)").bind(postId, author, content).run();
      return Response.json({ success: true });
    }
    if (url.pathname === "/api/comments" && request.method === "DELETE") {
      const { id } = await request.json();
      await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // R2 서빙
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const imageName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(imageName);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    return env.ASSETS.fetch(request);
  }
};