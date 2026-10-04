export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // OPTIONS 사전 요청(CORS) 지원
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // 공통 캐시 방지 JSON 응답 헬퍼
    const jsonResponse = (data, status = 200) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
          "Access-Control-Allow-Origin": "*"
        }
      });
    };

    // 1. [설정 API] D-Day, 이름, 타임라인, 휴일 등 공통 설정 관리
    if (url.pathname === "/api/settings" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
        const settings = {};
        (results || []).forEach(r => { settings[r.key] = r.value; });
        return jsonResponse(settings);
      } catch (e) { 
        return jsonResponse({}); 
      }
    }
    
    if (url.pathname === "/api/settings" && request.method === "POST") {
      try {
        const { key, value } = await request.json();
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
            .bind(key, value, value).run();
        return jsonResponse({ success: true });
      } catch (e) { 
        return jsonResponse({ error: e.message }, 500); 
      }
    }

    // 2. [파일 업로드 API] 배경, 프로필 등 관리자 전용 사진 교체
    if (url.pathname === "/api/admin/site-image" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const key = formData.get("key"); 
        const file = formData.get("image");
        if (!key || !file || file.size === 0) return jsonResponse({ error: "No file provided" }, 400);
        
        const ext = file.name.split(".").pop(); 
        const fileName = `site-${key}-${Date.now()}.${ext}`;
        await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
        
        const fileUrl = `/api/images/${fileName}`;
        await env.DB.prepare("INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?")
            .bind(key, fileUrl, fileUrl).run();
        
        return jsonResponse({ success: true, imageUrl: fileUrl });
      } catch (e) { 
        return jsonResponse({ error: e.message }, 500); 
      }
    }

    // 3. [인증 API] 커플 전용 비밀번호 인증 (0709)
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const inputPw = String(reqData.password || reqData.pw || "").trim();
        
        // 비밀번호 0709 확인 (아이디 유무 무관, 공백 제거 후 비교)
        if (inputPw === "0709") {
          return jsonResponse({ 
              success: true, 
              username: "ourlove", 
              fullName: "우리", // '우리'로 설정해야 index.html에서 작성자 선택 팝업(히니/효니)이 뜹니다.
              isAdmin: true, 
              status: "approved" 
          });
        }
        return jsonResponse({ error: "비밀번호가 올바르지 않습니다. 다시 입력해 주세요." }, 401);
      } catch (e) { 
        return jsonResponse({ error: e.message }, 500); 
      }
    }

    // 4. [게시글 & 캘린더 다이어리 API]
    if (url.pathname === "/api/posts" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
        return jsonResponse(results || []);
      } catch (e) {
        return jsonResponse([]);
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "POST") {
      try {
          const formData = await request.formData();
          const author = formData.get("author") || "익명"; 
          const username = formData.get("username") || "ourlove";
          const title = formData.get("title") || "무제"; 
          const category = formData.get("category") || "데이트록";
          const dateStr = formData.get("date") || ""; 
          const exactTime = formData.get("exactTime") || ""; // 일정 컬러
          const createdAt = formData.get("createdAt") || new Date().toISOString(); // 실제 작성 시간
          const content = formData.get("content") || ""; 
          const file = formData.get("image"); 
          
          let fileUrl = "";
          if (file && typeof file === "object" && file.size > 0 && file.name) {
            const ext = file.name.split(".").pop(); 
            const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
            fileUrl = `/api/images/${fileName}`;
          }
          
          // 저장 포맷: 이름(0)|아이디(1)|제목(2)|카테고리(3)|캘린더날짜(4)|일정색상(5)|작성일시(6)
          const authorMeta = `${author}|${username}|${title}|${category}|${dateStr}|${exactTime}|${createdAt}`;
          await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)")
              .bind(authorMeta, content, fileUrl).run();
              
          return jsonResponse({ success: true }, 200);
      } catch (e) {
          return jsonResponse({ error: e.message }, 500); 
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
          const exactTime = formData.get("exactTime") || ""; 
          const createdAt = formData.get("createdAt") || new Date().toISOString(); 
          const authorMeta = formData.get("authorMeta"); 
          const keepImage = formData.get("keepImage") || ""; 
          const file = formData.get("image");
          
          let fileUrl = keepImage;
          if (file && typeof file === "object" && file.size > 0 && file.name) {
            const ext = file.name.split(".").pop(); 
            const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            await env.BUCKET.put(fileName, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
            fileUrl = `/api/images/${fileName}`;
          }
          
          const newAuthorMeta = `${authorMeta}|${title}|${category}|${dateStr}|${exactTime}|${createdAt}`;
          await env.DB.prepare("UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?")
              .bind(newAuthorMeta, content, fileUrl, id).run();
              
          return jsonResponse({ success: true }, 200);
      } catch (e) {
          return jsonResponse({ error: e.message }, 500); 
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      try {
        const { id } = await request.json();
        const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
        if (post && post.image_url) { 
            try { await env.BUCKET.delete(post.image_url.replace("/api/images/", "")); } catch (err) {} 
        }
        await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
        await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 5. [댓글 API] - D1 테이블 자동 복구 및 다중 스키마 완벽 Fallback
    if (url.pathname === "/api/comments" && request.method === "GET") {
      try {
        const { results } = await env.DB.prepare("SELECT * FROM comments ORDER BY id ASC").all();
        return jsonResponse(results || []);
      } catch (e) {
        // comments 테이블이 없으면 자동 생성 시도
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS comments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              post_id INTEGER NOT NULL,
              author TEXT NOT NULL,
              content TEXT NOT NULL,
              created_at TEXT
            )
          `).run();
        } catch(initErr) {}
        return jsonResponse([]);
      }
    }
    
    if (url.pathname === "/api/comments" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const pId = parseInt(reqData.postId || reqData.post_id || 0, 10);
        const author = String(reqData.author || "우리").trim();
        // comments.username NOT NULL 제약조건 완벽 대응
        const username = String(reqData.username || (author === "효니" ? "hyoni" : (author === "히니" ? "hini" : "ourlove"))).trim();
        const content = String(reqData.content || "").trim();
        const commentTime = reqData.exactTime || reqData.created_at || new Date().toISOString();

        if (!pId) {
          return jsonResponse({ error: "게시글 번호(postId)가 유효하지 않습니다." }, 400);
        }
        if (!content) {
          return jsonResponse({ error: "댓글 내용을 입력해 주세요." }, 400);
        }

        // 테이블이 존재하지 않을 경우 자동 생성 (username 컬럼 포함)
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS comments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              post_id INTEGER NOT NULL,
              author TEXT NOT NULL,
              username TEXT NOT NULL DEFAULT 'ourlove',
              content TEXT NOT NULL,
              created_at TEXT
            )
          `).run();
        } catch(tblErr) {}

        // 1차 시도: username, created_at 컬럼 모두 포함
        try {
          await env.DB.prepare("INSERT INTO comments (post_id, author, username, content, created_at) VALUES (?, ?, ?, ?, ?)")
              .bind(pId, author, username, content, commentTime).run();
        } catch (colErr1) {
          // 2차 시도: created_at 컬럼이 없는 스키마 (post_id, author, username, content)
          try {
            await env.DB.prepare("INSERT INTO comments (post_id, author, username, content) VALUES (?, ?, ?, ?)")
                .bind(pId, author, username, `${content}__time:${commentTime}__`).run();
          } catch (colErr2) {
            // 3차 시도: username 컬럼이 없는 스키마 (post_id, author, content, created_at)
            try {
              await env.DB.prepare("INSERT INTO comments (post_id, author, content, created_at) VALUES (?, ?, ?, ?)")
                  .bind(pId, author, content, commentTime).run();
            } catch (colErr3) {
              // 4차 시도: 최소 스키마 (post_id, author, content)
              await env.DB.prepare("INSERT INTO comments (post_id, author, content) VALUES (?, ?, ?)")
                  .bind(pId, author, `${content}__time:${commentTime}__`).run();
            }
          }
        }
        return jsonResponse({ success: true }, 200);
      } catch (e) {
        return jsonResponse({ error: `댓글 저장 오류: ${e.message}` }, 500);
      }
    }
    
    if (url.pathname === "/api/comments" && request.method === "DELETE") {
      try {
        const { id } = await request.json();
        await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ error: e.message }, 500);
      }
    }

    // 6. [R2 버킷 미디어 서빙]
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      const fileName = url.pathname.replace("/api/images/", "");
      const object = await env.BUCKET.get(fileName);
      if (!object) return new Response("Not found", { status: 404 });
      
      const headers = new Headers(); 
      object.writeHttpMetadata(headers); 
      headers.set("etag", object.httpEtag);
      headers.set("Accept-Ranges", "bytes");
      headers.set("Cache-Control", "public, max-age=86400");
      
      return new Response(object.body, { headers });
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
