export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. [설정 API] D-Day, 이름, 타임라인, 휴일 등 공통 설정 관리
    if (url.pathname === "/api/settings" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
        const settings = {};
        (results || []).forEach(r => { settings[r.key] = r.value; });
        return Response.json(settings);
      } catch (e) { 
        return Response.json({}); 
      }
    }
    
    if (url.pathname === "/api/settings" && request.method === "POST") {
      try {
        const { key, value } = await request.json();
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
            .bind(key, value, value).run();
        return Response.json({ success: true });
      } catch (e) { 
        return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
    }

    // 2. [파일 업로드 API] 배경, 프로필 등 관리자 전용 사진 교체
    if (url.pathname === "/api/admin/site-image" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const key = formData.get("key"); 
        const file = formData.get("image");
        if (!key || !file || file.size === 0) return new Response("No file", { status: 400 });
        
        const ext = file.name.split(".").pop(); 
        const fileName = `site-${key}-${Date.now()}.${ext}`;
        await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
        
        const fileUrl = `/api/images/${fileName}`;
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
            .bind(key, fileUrl, fileUrl).run();
        
        return Response.json({ success: true, imageUrl: fileUrl });
      } catch (e) { 
        return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
    }

   // 3. [인증 API] 커플 전용 고정 아이디/비밀번호 (가입 불가)
if (url.pathname === "/api/login" && request.method === "POST") {
  try {
    const { username, password } = await request.json();
    
    // 🔐 고정 접속 정보: 아이디 ourlove / 비밀번호 1004
    if (username === "ourlove" && password === "1004") {
      return Response.json({ 
          success: true, 
          username: "ourlove", 
          fullName: "우리", // '우리'로 설정해야 index.html에서 작성자 선택 팝업이 뜹니다.
          isAdmin: true, 
          status: "approved" 
      });
    }
    return new Response(JSON.stringify({ error: "아이디 또는 비밀번호가 틀렸습니다. 우리만의 암호를 입력해 주세요." }), { status: 401 });
  } catch (e) { 
    return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
  }
}

    // 4. [게시글 & 캘린더 다이어리 API] - 영상/음성 확장 지원
    if (url.pathname === "/api/posts" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
      return Response.json(results || []);
    }
    
    if (url.pathname === "/api/posts" && request.method === "POST") {
      try {
          const formData = await request.formData();
          const author = formData.get("author") || "익명"; 
          const username = formData.get("username") || "ourlove";
          const title = formData.get("title") || "무제"; 
          const category = formData.get("category") || "데이트록";
          const dateStr = formData.get("date") || ""; // 다이어리/일정용 날짜
          const exactTime = formData.get("exactTime") || new Date().toISOString(); // 초단위 기록용
          const content = formData.get("content") || ""; 
          const file = formData.get("image"); // 이름은 image지만 video/audio 모두 가능
          
          let fileUrl = "";
          if (file && typeof file === "object" && file.size > 0 && file.name) {
            const ext = file.name.split(".").pop(); 
            const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
            fileUrl = `/api/images/${fileName}`;
          }
          
          // 저장 포맷: 이름|아이디|제목|카테고리|캘린더날짜|정확한시간
          const authorMeta = `${author}|${username}|${title}|${category}|${dateStr}|${exactTime}`;
          await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)")
              .bind(authorMeta, content, fileUrl).run();
              
          return new Response("OK", { status: 200 });
      } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "PUT") {
      try {
          const formData = await request.formData();
          const id = formData.get("id"); 
          const title = formData.get("title") || "무제"; 
          const category = formData.get("category") || "데이트록";
          const content = formData.get("content") || ""; 
          const dateStr = formData.get("date") || ""; 
          const exactTime = formData.get("exactTime") || new Date().toISOString();
          const authorMeta = formData.get("authorMeta"); // 이름|아이디
          const keepImage = formData.get("keepImage") || ""; 
          const file = formData.get("image");
          
          let fileUrl = keepImage;
          if (file && typeof file === "object" && file.size > 0 && file.name) {
            const ext = file.name.split(".").pop(); 
            const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
            fileUrl = `/api/images/${fileName}`;
          }
          
          const newAuthorMeta = `${authorMeta}|${title}|${category}|${dateStr}|${exactTime}`;
          await env.DB.prepare("UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?")
              .bind(newAuthorMeta, content, fileUrl, id).run();
              
          return new Response("OK", { status: 200 });
      } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 }); 
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      const { id } = await request.json();
      const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
      if (post && post.image_url) { 
          try { await env.BUCKET.delete(post.image_url.replace("/api/images/", "")); } catch (err) {} 
      }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
      await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // 5. [댓글 API]
    if (url.pathname === "/api/comments" && request.method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM comments ORDER BY id ASC").all();
      return Response.json(results || []);
    }
    
    if (url.pathname === "/api/comments" && request.method === "POST") {
      const { postId, author, content, exactTime } = await request.json();
      // comments 테이블에 created_at(시간) 정보도 함께 저장하도록 보완
      await env.DB.prepare("INSERT INTO comments (post_id, author, content, created_at) VALUES (?, ?, ?, ?)")
          .bind(postId, author, content, exactTime || new Date().toISOString()).run();
      return Response.json({ success: true });
    }
    
    if (url.pathname === "/api/comments" && request.method === "DELETE") {
      const { id } = await request.json();
      await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
      return Response.json({ success: true });
    }

    // 6. [R2 버킷 미디어 서빙] - 영상, 음성, 이미지 모두 지원
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const fileName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(fileName);
      if (!object) return new Response("Not found", { status: 404 });
      
      const headers = new Headers(); 
      object.writeHttpMetadata(headers); 
      headers.set("etag", object.httpEtag);
      
      // 영상 파일 재생을 위한 범위 요청(Range) 처리를 간단히 허용
      headers.set("Accept-Ranges", "bytes");
      
      return new Response(object.body, { headers });
    }

    return env.ASSETS.fetch(request);
  }
};