/*
 * 커플 프라이빗 페이지 Backend (_worker.js)
 * - 설정(D-Day, 사진) 관리, 게시물/댓글 CRUD, 암호화 로그인 통신
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 설정 API (D-Day 및 상단 문구 가져오기/저장하기)
    if (url.pathname === "/api/settings" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
        const settings = {};
        (results || []).forEach(r => { settings[r.key] = r.value; });
        return Response.json(settings);
      } catch (e) { return Response.json({}); }
    }
    if (url.pathname === "/api/settings" && request.method === "POST") {
      try {
        const { key, value } = await request.json();
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(key, value, value).run();
        return Response.json({ success: true });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // 2. 인증 API (비밀스런 진입을 위한 로그인/가입)
    if (url.pathname === "/api/signup" && request.method === "POST") {
      try {
        const { username, password, fullName } = await request.json();
        const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(username).first();
        if (existing) return new Response(JSON.stringify({ error: "이미 존재하는 아이디입니다." }), { status: 400 });

        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        // 커플 페이지이므로 가입 즉시 승인(approved) 처리하거나 첫 2명만 허용하는 등의 로직 가능. 여기선 일단 approved 처리.
        await env.DB.prepare("INSERT INTO users (username, password, full_name, status) VALUES (?, ?, ?, 'approved')").bind(username, hashedPassword, fullName).run();
        return Response.json({ success: true });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const { username, password } = await request.json();
        
        // 관리자 강제 접속 계정 (필요시 커플 중 1명을 admin으로 설정)
        if (username === "admin" && password === "admin") {
          return Response.json({ success: true, username: "admin", fullName: "Admin", isAdmin: true, status: "approved" });
        }

        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashedPassword = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

        const user = await env.DB.prepare("SELECT * FROM users WHERE username = ? AND password = ?").bind(username, hashedPassword).first();
        if (!user) return new Response(JSON.stringify({ error: "접근 권한이 없습니다." }), { status: 401 });

        // 첫 번째 가입자나 특정 아이디를 어드민으로 설정할 수도 있습니다. 여기서는 모두 수정 권한을 줍니다.
        return Response.json({ success: true, id: user.id, username: user.username, fullName: user.full_name, isAdmin: true, status: user.status });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // 3. 사진 관리 API (R2 연동)
    if (url.pathname === "/api/admin/site-image" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const key = formData.get("key"); 
        const image = formData.get("image");
        if (!key || !image || image.size === 0) return new Response(JSON.stringify({ error: "파일 필요" }), { status: 400 });
        const ext = image.name.split(".").pop();
        const fileName = `site-${key}-${Date.now()}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type } });
        const imageUrl = `/api/images/${fileName}`;
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").bind(key, imageUrl, imageUrl).run();
        return Response.json({ success: true, imageUrl });
      } catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 500 }); }
    }

    // 4. 데이트 기록 (게시글) API
    if (url.pathname === "/api/posts" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
      return Response.json(results || []);
    }
    if (url.pathname === "/api/posts" && request.method === "POST") {
      const formData = await request.formData();
      const author = formData.get("author") || "익명"; const username = formData.get("username") || "";
      const title = formData.get("title") || "무제"; const category = formData.get("category") || "데이트록";
      const content = formData.get("content") || ""; const image = formData.get("image");
      let imageUrl = "";
      if (image && image.size > 0) {
        const ext = image.name.split(".").pop(); const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type } });
        imageUrl = `/api/images/${fileName}`;
      }
      await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)").bind(`${author}|${username}|${title}|${category}`, content, imageUrl).run();
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/api/posts" && request.method === "PUT") {
      const formData = await request.formData();
      const id = formData.get("id"); const authorMeta = formData.get("authorMeta"); const category = formData.get("category");
      const title = formData.get("title"); const content = formData.get("content"); const keepImage = formData.get("keepImage");
      const image = formData.get("image");
      let imageUrl = keepImage;
      if (image && image.size > 0) {
        const ext = image.name.split(".").pop(); const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
        await env.BUCKET.put(fileName, image.stream(), { httpMetadata: { contentType: image.type } });
        imageUrl = `/api/images/${fileName}`;
      }
      await env.DB.prepare("UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?").bind(`${authorMeta}|${title}|${category}`, content, imageUrl, id).run();
      return new Response("OK", { status: 200 });
    }
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      const { id } = await request.json();
      const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
      if (post && post.image_url) { try { await env.BUCKET.delete(post.image_url.replace("/api/images/", "")); } catch (e) {} }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // 5. 방명록/편지 (댓글) API
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