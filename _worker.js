/**
 * ==============================================================================
 * Our Secret Space · Cloudflare Workers Backend Engine (_worker.js)
 * - 커플 전용 시크릿 다이어리, 캘린더, 사진 갤러리, 실시간 Q&A, 위시리스트,
 *   하루 일정 플래너(Itinerary), 여행 준비물(Packing List), 감성 메모장 통합 API
 * - D1 Database (SQLite) & Cloudflare R2 Bucket 미디어 스트리밍 완벽 지원
 * - 비밀번호 서버측 안전 검증 & 다중 게시글 일괄 삭제(Batch Delete) 지원
 * - 견고한 다중 스키마 Fallback 및 자동 D1 테이블 마이그레이션 복구 탑재
 * ==============================================================================
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ============================================================================
    // [0. CORS 및 프리플라이트(OPTIONS) 사전 요청 핸들러]
    // ============================================================================
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    // ============================================================================
    // [공통 응답 헬퍼 함수: 캐시 방지 및 UTF-8 JSON 응답 생성]
    // ============================================================================
    const jsonResponse = (data, status = 200, customHeaders = {}) => {
      return new Response(JSON.stringify(data), {
        status,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
          "Pragma": "no-cache",
          "Expires": "0",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          ...customHeaders
        }
      });
    };

    // 공통 에러 응답 헬퍼
    const errorResponse = (message, status = 500, details = null) => {
      const payload = { error: message, success: false, timestamp: new Date().toISOString() };
      if (details) payload.details = details;
      return jsonResponse(payload, status);
    };

    // ============================================================================
    // [1. 설정 API: D-Day, 호칭, 타임라인, 버킷리스트, Q&A, 일정 플래너, 패킹리스트, 비밀번호]
    // ============================================================================
    if (url.pathname === "/api/settings" && request.method === "GET") {
      try {
        // site_settings 테이블 자동 생성 보장
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS site_settings (
              key TEXT PRIMARY KEY,
              value TEXT
            )
          `).run();
        } catch (tblErr) {
          console.warn("site_settings table verification notice:", tblErr.message);
        }

        const { results } = await env.DB.prepare("SELECT key, value FROM site_settings").all();
        const settings = {};
        (results || []).forEach(r => { 
          // 보안을 위해 비밀번호(site_password)는 클라이언트에 직접 노출하지 않음
          if (r && r.key && r.key !== "site_password") {
            settings[r.key] = r.value; 
          }
        });
        return jsonResponse(settings);
      } catch (e) {
        console.error("Fetch settings error:", e);
        return jsonResponse({});
      }
    }
    
    if (url.pathname === "/api/settings" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        
        // 단일 키-값 저장 및 다중 키-값 일괄 저장(batch) 모두 지원
        if (body.settings && typeof body.settings === "object") {
          // 일괄 업데이트 모드
          const entries = Object.entries(body.settings);
          for (const [k, v] of entries) {
            const valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
            await env.DB.prepare(`
              INSERT INTO site_settings (key, value) VALUES (?, ?) 
              ON CONFLICT(key) DO UPDATE SET value = ?
            `).bind(k, valStr, valStr).run();
          }
          return jsonResponse({ success: true, count: entries.length });
        } else {
          // 단일 키-값 모드
          const { key, value } = body;
          if (!key) return errorResponse("Key is required", 400);
          
          const valStr = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
          await env.DB.prepare(`
            INSERT INTO site_settings (key, value) VALUES (?, ?) 
            ON CONFLICT(key) DO UPDATE SET value = ?
          `).bind(key, valStr, valStr).run();
          return jsonResponse({ success: true, key });
        }
      } catch (e) {
        console.error("Save settings error:", e);
        return errorResponse(`설정 저장 중 오류가 발생했습니다: ${e.message}`, 500);
      }
    }

    // ============================================================================
    // [2. 파일 업로드 API: 배경(배너), 프로필 사진 R2 저장 및 설정 테이블 연동]
    // ============================================================================
    if (url.pathname === "/api/admin/site-image" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const key = formData.get("key"); 
        const file = formData.get("image");
        if (!key || !file || !(file instanceof Blob) || file.size === 0) {
          return errorResponse("유효한 이미지 파일이 전달되지 않았습니다.", 400);
        }
        
        const ext = file.name ? file.name.split(".").pop().toLowerCase() : "jpg"; 
        const fileName = `site-${key}-${Date.now()}.${ext}`;
        await env.BUCKET.put(fileName, file.stream(), { 
          httpMetadata: { contentType: file.type || "image/jpeg" } 
        });
        
        const fileUrl = `/api/images/${fileName}`;
        
        // 다중 배너 이미지 추가 모드인 경우
        if (key === "banner_add") {
          let bannerList = [];
          try {
            const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'banner_images'").first();
            if (row && row.value) bannerList = JSON.parse(row.value);
          } catch(e) {}
          bannerList.push(fileUrl);
          await env.DB.prepare(`
            INSERT INTO site_settings (key, value) VALUES (?, ?) 
            ON CONFLICT(key) DO UPDATE SET value = ?
          `).bind("banner_images", JSON.stringify(bannerList), JSON.stringify(bannerList)).run();
          return jsonResponse({ success: true, imageUrl: fileUrl, bannerList });
        }

        // 일반 단일 설정 이미지
        await env.DB.prepare(`
          INSERT INTO site_settings (key, value) VALUES (?, ?) 
          ON CONFLICT(key) DO UPDATE SET value = ?
        `).bind(key, fileUrl, fileUrl).run();
        
        return jsonResponse({ success: true, imageUrl: fileUrl, key });
      } catch (e) {
        console.error("Upload site image error:", e);
        return errorResponse(`이미지 업로드 오류: ${e.message}`, 500);
      }
    }

    // ============================================================================
    // [3. 인증 API: 서버측 비밀번호 안전 검증 (F12 노출 원천 차단)]
    // ============================================================================
    if (url.pathname === "/api/login" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const inputPw = String(reqData.password || reqData.pw || "").trim();
        
        if (!inputPw) {
          return errorResponse("비밀번호를 입력해 주세요.", 400);
        }

        // 1순위: Cloudflare 환경 변수 ACCESS_PASSWORD
        // 2순위: D1 site_settings 테이블의 site_password 값
        // 3순위: 기본 비밀번호 0709
        let serverTargetPw = "0709";
        try {
          if (env.ACCESS_PASSWORD) {
            serverTargetPw = String(env.ACCESS_PASSWORD).trim();
          } else {
            const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'site_password'").first();
            if (row && row.value) {
              serverTargetPw = String(row.value).trim();
            }
          }
        } catch(pwErr) {
          console.warn("DB password read error, falling back to default:", pwErr.message);
        }

        // 서버 측에서만 비밀번호 검증 수행
        if (inputPw === serverTargetPw) {
          return jsonResponse({ 
            success: true, 
            username: "ourlove", 
            fullName: "우리", // '우리'로 설정해야 클라이언트에서 히니/효니 선택 팝업이 활성화됩니다.
            isAdmin: true, 
            status: "approved",
            message: "인증에 성공하였습니다. 환영합니다! 💖"
          });
        }
        return errorResponse("비밀번호가 올바르지 않습니다. 다시 입력해 주세요.", 401);
      } catch (e) {
        return errorResponse(`인증 오류: ${e.message}`, 500);
      }
    }

    // 비밀번호 변경 전용 API
    if (url.pathname === "/api/change-password" && request.method === "POST") {
      try {
        const { currentPassword, newPassword } = await request.json().catch(() => ({}));
        if (!newPassword || newPassword.trim().length < 2) {
          return errorResponse("새 비밀번호는 2자리 이상이어야 합니다.", 400);
        }

        let serverTargetPw = "0709";
        try {
          if (env.ACCESS_PASSWORD) {
            serverTargetPw = String(env.ACCESS_PASSWORD).trim();
          } else {
            const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key = 'site_password'").first();
            if (row && row.value) serverTargetPw = String(row.value).trim();
          }
        } catch(e) {}

        if (String(currentPassword).trim() !== serverTargetPw) {
          return errorResponse("현재 비밀번호가 일치하지 않습니다.", 401);
        }

        await env.DB.prepare(`
          INSERT INTO site_settings (key, value) VALUES ('site_password', ?) 
          ON CONFLICT(key) DO UPDATE SET value = ?
        `).bind(newPassword.trim(), newPassword.trim()).run();

        return jsonResponse({ success: true, message: "비밀번호가 성공적으로 변경되었습니다." });
      } catch(e) {
        return errorResponse(`비밀번호 변경 실패: ${e.message}`, 500);
      }
    }

    // ============================================================================
    // [4. 게시글 & 캘린더 다이어리 API: 조회, 등록, 수정, 단일/다중 일괄 삭제]
    // ============================================================================
    if (url.pathname === "/api/posts" && request.method === "GET") {
      try {
        // posts 테이블 자동 생성 보장
        try {
          await env.DB.prepare(`
            CREATE TABLE IF NOT EXISTS posts (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              author TEXT NOT NULL,
              content TEXT,
              image_url TEXT,
              created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
          `).run();
        } catch (tErr) {}

        const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY id DESC").all();
        return jsonResponse(results || []);
      } catch (e) {
        console.error("Fetch posts error:", e);
        return jsonResponse([]);
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "POST") {
      try {
        const formData = await request.formData();
        const author = formData.get("author") || "익명"; 
        const username = formData.get("username") || "ourlove";
        const title = formData.get("title") || "무제"; 
        const category = formData.get("category") || "일상";
        const dateStr = formData.get("date") || ""; 
        const exactTime = formData.get("exactTime") || ""; // 일정 컬러
        const createdAt = formData.get("createdAt") || new Date().toISOString(); 
        const content = formData.get("content") || ""; 
        
        // 다중 사진 첨부 완벽 수집 (formData.getAll 로 images 및 image 모두 수용)
        const rawFiles = [...formData.getAll("images"), ...formData.getAll("image")];
        const validFiles = rawFiles.filter(f => f && typeof f === "object" && f.size > 0 && f.name);
        
        const fileUrls = [];
        for (const file of validFiles) {
          const ext = file.name ? file.name.split(".").pop().toLowerCase() : "jpg"; 
          const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
          await env.BUCKET.put(fileName, file.stream(), { 
            httpMetadata: { contentType: file.type || "image/jpeg" } 
          });
          fileUrls.push(`/api/images/${fileName}`);
        }
        
        // 1장이면 단일 문자열, 여러 장이면 JSON 배열 문자열 보관
        let finalImageUrl = "";
        if (fileUrls.length === 1) {
          finalImageUrl = fileUrls[0];
        } else if (fileUrls.length > 1) {
          finalImageUrl = JSON.stringify(fileUrls);
        }
        
        // 메타데이터 포맷: 이름(0)|아이디(1)|제목(2)|카테고리(3)|날짜(4)|색상(5)|작성일시(6)
        const authorMeta = `${author}|${username}|${title}|${category}|${dateStr}|${exactTime}|${createdAt}`;
        await env.DB.prepare("INSERT INTO posts (author, content, image_url) VALUES (?, ?, ?)")
            .bind(authorMeta, content, finalImageUrl).run();
            
        return jsonResponse({ success: true, imageUrl: finalImageUrl }, 200);
      } catch (e) {
        console.error("Create post error:", e);
        return errorResponse(`게시글 저장 오류: ${e.message}`, 500);
      }
    }
    
    if (url.pathname === "/api/posts" && request.method === "PUT") {
      try {
        const formData = await request.formData();
        const id = formData.get("id"); 
        if (!id) return errorResponse("게시글 번호(id)가 누락되었습니다.", 400);

        const title = formData.get("title") || "무제"; 
        const category = formData.get("category") || "일상";
        const content = formData.get("content") || ""; 
        const dateStr = formData.get("date") || ""; 
        const exactTime = formData.get("exactTime") || ""; 
        const createdAt = formData.get("createdAt") || new Date().toISOString(); 
        const authorMeta = formData.get("authorMeta") || "우리|ourlove"; 
        const keepImage = formData.get("keepImage") || ""; 
        
        // 새로 업로드된 다중 파일 수집
        const rawFiles = [...formData.getAll("images"), ...formData.getAll("image")];
        const validFiles = rawFiles.filter(f => f && typeof f === "object" && f.size > 0 && f.name);
        
        let finalImageUrl = keepImage;
        if (validFiles.length > 0) {
          const newUrls = [];
          for (const file of validFiles) {
            const ext = file.name ? file.name.split(".").pop().toLowerCase() : "jpg"; 
            const fileName = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
            await env.BUCKET.put(fileName, file.stream(), { 
              httpMetadata: { contentType: file.type || "image/jpeg" } 
            });
            newUrls.push(`/api/images/${fileName}`);
          }
          finalImageUrl = newUrls.length === 1 ? newUrls[0] : JSON.stringify(newUrls);
        }
        
        const newAuthorMeta = `${authorMeta}|${title}|${category}|${dateStr}|${exactTime}|${createdAt}`;
        await env.DB.prepare("UPDATE posts SET author = ?, content = ?, image_url = ? WHERE id = ?")
            .bind(newAuthorMeta, content, finalImageUrl, id).run();
            
        return jsonResponse({ success: true, imageUrl: finalImageUrl }, 200);
      } catch (e) {
        console.error("Update post error:", e);
        return errorResponse(`게시글 수정 오류: ${e.message}`, 500);
      }
    }
    
    // 단일 및 다중 일괄 삭제(Batch Delete) 완벽 지원
    if (url.pathname === "/api/posts" && request.method === "DELETE") {
      try {
        const body = await request.json().catch(() => ({}));
        
        // ids 배열이 전달된 경우 다중 일괄 삭제
        const idsToDelete = Array.isArray(body.ids) ? body.ids : (body.id ? [body.id] : []);
        if (idsToDelete.length === 0) {
          return errorResponse("삭제할 게시글 번호(id 또는 ids)가 제공되지 않았습니다.", 400);
        }

        let deletedCount = 0;
        for (const id of idsToDelete) {
          // 연관 이미지 R2 삭제
          const post = await env.DB.prepare("SELECT image_url FROM posts WHERE id = ?").bind(id).first();
          if (post && post.image_url) { 
            const rawUrl = post.image_url.trim();
            if (rawUrl.startsWith('[') && rawUrl.endsWith(']')) {
              try {
                const arr = JSON.parse(rawUrl);
                for (const u of arr) {
                  try { 
                    await env.BUCKET.delete(String(u).replace("/api/images/", "")); 
                  } catch(delErr) {}
                }
              } catch(e) {}
            } else {
              try { 
                await env.BUCKET.delete(rawUrl.replace("/api/images/", "")); 
              } catch (err) {} 
            }
          }
          await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
          await env.DB.prepare("DELETE FROM comments WHERE post_id = ?").bind(id).run();
          deletedCount++;
        }

        return jsonResponse({ success: true, count: deletedCount });
      } catch (e) {
        console.error("Delete posts error:", e);
        return errorResponse(`게시글 삭제 오류: ${e.message}`, 500);
      }
    }

    // ============================================================================
    // [5. 댓글 API: D1 테이블 자동 복구 및 다중 스키마 완벽 호환]
    // ============================================================================
    if (url.pathname === "/api/comments" && request.method === "GET") {
      try {
        // comments 테이블 자동 복구 보장
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
        } catch(initErr) {}

        const { results } = await env.DB.prepare("SELECT * FROM comments ORDER BY id ASC").all();
        return jsonResponse(results || []);
      } catch (e) {
        return jsonResponse([]);
      }
    }
    
    if (url.pathname === "/api/comments" && request.method === "POST") {
      try {
        const reqData = await request.json().catch(() => ({}));
        const pId = parseInt(reqData.postId || reqData.post_id || 0, 10);
        const author = String(reqData.author || "우리").trim();
        const username = String(reqData.username || (author === "효니" ? "hyoni" : (author === "히니" ? "hini" : "ourlove"))).trim();
        const content = String(reqData.content || "").trim();
        const commentTime = reqData.exactTime || reqData.created_at || new Date().toISOString();

        if (!pId) return errorResponse("게시글 번호(postId)가 유효하지 않습니다.", 400);
        if (!content) return errorResponse("댓글 내용을 입력해 주세요.", 400);

        // 테이블 부재 시 생성
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

        // 1차 시도: username, created_at 포함
        try {
          await env.DB.prepare("INSERT INTO comments (post_id, author, username, content, created_at) VALUES (?, ?, ?, ?, ?)")
              .bind(pId, author, username, content, commentTime).run();
        } catch (colErr1) {
          // 2차 시도: created_at 컬럼 없는 스키마
          try {
            await env.DB.prepare("INSERT INTO comments (post_id, author, username, content) VALUES (?, ?, ?, ?)")
                .bind(pId, author, username, `${content}__time:${commentTime}__`).run();
          } catch (colErr2) {
            // 3차 시도: username 컬럼 없는 스키마
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
        return jsonResponse({ success: true, postId: pId }, 200);
      } catch (e) {
        console.error("Save comment error:", e);
        return errorResponse(`댓글 저장 오류: ${e.message}`, 500);
      }
    }
    
    if (url.pathname === "/api/comments" && request.method === "DELETE") {
      try {
        const { id } = await request.json().catch(() => ({}));
        if (!id) return errorResponse("댓글 id가 제공되지 않았습니다.", 400);
        await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
        return jsonResponse({ success: true });
      } catch (e) {
        return errorResponse(`댓글 삭제 오류: ${e.message}`, 500);
      }
    }

    // ============================================================================
    // [6. R2 버킷 미디어 서빙: 고화질 사진 고속 스트리밍 및 캐싱]
    // ============================================================================
    if (url.pathname.startsWith("/api/images/") && request.method === "GET") {
      try {
        const fileName = url.pathname.replace("/api/images/", "");
        if (!fileName) return new Response("Filename not specified", { status: 400 });

        const object = await env.BUCKET.get(fileName);
        if (!object) return new Response("Image not found", { status: 404 });
        
        const headers = new Headers(); 
        object.writeHttpMetadata(headers); 
        headers.set("etag", object.httpEtag);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
        headers.set("Access-Control-Allow-Origin", "*");
        
        return new Response(object.body, { headers });
      } catch (e) {
        return new Response(`Media error: ${e.message}`, { status: 500 });
      }
    }

    // ============================================================================
    // [7. 정적 애셋(SPA HTML/CSS/JS) 서빙: Cloudflare Pages / Assets]
    // ============================================================================
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};