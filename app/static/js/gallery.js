/**
 * Gallery JS
 */
(function(){
'use strict';
const state={images:[],currentPage:1,totalPages:1,sort:'likes',viewMode:'grid',
    commentSort:'newest',
    fingerprint:'',token:localStorage.getItem('token'),
    username:localStorage.getItem('username'),isAdmin:localStorage.getItem('is_admin')==='true',
    likedIds:new Set(),currentPreview:null,viewingMy:false};
const el=id=>document.getElementById(id);
const $$=s=>document.querySelectorAll(s);
const E={grid:el('galleryGrid'),myGrid:el('myImagesGrid'),
    pagination:el('pagination'),empty:el('emptyState'),loading:el('loadingOverlay'),
    userArea:el('userArea'),pvModal:el('previewModal'),pvImg:el('previewImage'),
    pvModel:el('previewModel'),pvDate:el('previewDate'),pvPrompt:el('previewPrompt'),
    pvLikes:el('previewLikeCount'),pvLikeBtn:el('previewLikeBtn'),pvDownload:el('previewDownload'),
    pvClose:el('previewClose'),pvPid:el('previewPid'),pvAvatar:el('pvAvatar'),pvNickname:el('pvNickname'),pvUid:el('pvUid'),
    commentList:el('commentList'),commentCount:el('commentCount'),commentInput:el('commentInput'),
    commentText:el('commentText'),commentSubmit:el('commentSubmit'),commentLoginHint:el('commentLoginHint'),
    lgModal:el('loginModal'),lgForm:el('loginForm'),lgClose:el('loginClose'),lgError:el('loginError'),
    uc:el('userCenter'),ucAvatar:el('ucAvatar'),ucNickname:el('ucNickname'),ucUid:el('ucUid'),
    ucImgCount:el('ucImgCount'),ucLikeCount:el('ucLikeCount'),ucEdit:el('ucEdit'),
    ucEditBtn:el('ucEditBtn'),ucBackBtn:el('ucBackBtn'),ucSaveBtn:el('ucSaveBtn'),
    ucNickInput:el('ucNickInput'),ucAvatarInput:el('ucAvatarInput'),ucAvatarEdit:el('ucAvatarEdit'),
    ucBio:el('ucBio'),ucBioInput:el('ucBioInput'),ucHomeLink:el('ucHomeLink'),
    searchInput:el('searchInput'),searchScope:el('searchScope'),searchGo:el('searchGo'),
    sortBtns:$$('.sort-btn'),viewBtns:$$('.view-btn')};
function genFP(){const c=document.createElement('canvas'),ctx=c.getContext('2d');c.width=200;c.height=50;
    ctx.textBaseline='top';ctx.font='14px Arial';ctx.fillStyle='#f60';ctx.fillRect(125,1,62,20);
    ctx.fillStyle='#069';ctx.fillText('浅夜の梦',2,15);
    const gl=document.createElement('canvas').getContext('webgl');
    const di=gl?gl.getExtension('WEBGL_debug_renderer_info'):null;
    const r=di?gl.getParameter(di.UNMASKED_RENDERER_WEBGL):'';
    const raw=[navigator.userAgent,screen.width+'x'+screen.height,screen.colorDepth,
        new Date().getTimezoneOffset(),c.toDataURL(),r,navigator.language].join('|');
    let h=0;for(let i=0;i<raw.length;i++){h=((h<<5)-h)+raw.charCodeAt(i);h=h&h;}
    return Math.abs(h).toString(16);}
function esc(t){const d=document.createElement('div');d.textContent=t;return d.innerHTML;}
function setLoading(s){E.loading.classList.toggle('show',s);}
function fmtDate(s){if(!s)return'';var d=new Date(s);return d.toLocaleDateString('zh-CN',{year:'numeric',month:'long',day:'numeric'})+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}

function customConfirm(msg){
    return new Promise(function(resolve){
        var o=document.createElement('div');o.className='confirm-overlay';
        o.innerHTML='<div class="confirm-box"><p>'+msg+'</p><div class="confirm-btns">'
            +'<button class="btn" id="cfNo">\u53D6\u6D88</button><button class="btn btn-primary" id="cfYes">\u786E\u5B9A</button></div></div>';
        document.body.appendChild(o);
        o.querySelector('#cfNo').onclick=function(){o.remove();resolve(false);};
        o.querySelector('#cfYes').onclick=function(){o.remove();resolve(true);};
    });
}

async function doSearch(){
    var q=(E.searchInput.value||'').trim();if(!q){loadImages();return;}
    var scope=E.searchScope.value;
    setLoading(true);
    try{var r=await fetch('/api/gallery/search?q='+encodeURIComponent(q)+'&scope='+scope+'&page='+state.currentPage);
        var d=await r.json();state.images=d.data||[];state.totalPages=d.total_pages||1;
        renderGrid(state.images,E.grid);renderPages();
    }catch(e){console.error(e);}finally{setLoading(false);}
}
function renderUser(){
    if(state.token){
        E.userArea.innerHTML='<span class="user-greeting">\u{1F44B} '+esc(state.username||'')+'</span>'
            +'<button class="my-btn" id="myBtn">\u{1F4F8} \u6211\u7684</button>'
            +'<button class="logout-btn" id="logoutBtn">\u9000\u51FA</button>'
            +(state.isAdmin?'<a href="/admin" class="admin-link">\u2699\uFE0F \u7BA1\u7406</a>':'');
        el('myBtn').onclick=showMy;el('logoutBtn').onclick=logout;
    }else{
        E.userArea.innerHTML='<button class="login-trigger" id="loginBtn">\u{1F510} \u767B\u5F55</button>';
        el('loginBtn').onclick=function(){E.lgModal.classList.add('show');document.body.style.overflow='hidden';E.lgError.hidden=true;};
    }
}
function renderGrid(images,container,showManage){
    if(!images||!images.length){E.empty.hidden=false;container.innerHTML='';return;}
    E.empty.hidden=true;
    container.innerHTML=images.map(function(img){
        var vis=img.is_public===0?'\u{1F512}':'';
        var avatar=img.avatar_url||'/api/gallery/gen-avatar/'+(img.username||'u');
        var author=img.nickname||img.username||'\u4F5C\u8005';
        var title=img.title||img.model||'\u672A\u547D\u540D\u4F5C\u54C1';
        var views=Number(img.view_count)||0;
        var mgmt=showManage?'<div class="grid-manage">'
            +'<button class="gm-btn gm-edit" data-id="'+img.id+'" data-title="'+esc(img.title||'')+'" title="\u7F16\u8F91\u6807\u9898">\u270F\uFE0F</button>'
            +'<button class="gm-btn gm-vis" data-id="'+img.id+'" title="'+(img.is_public===0?'\u516C\u5F00':'\u9690\u85CF')+'">'+(img.is_public===0?'\u{1F512}':'\u{1F513}')+'</button>'
            +'<button class="gm-btn gm-del" data-id="'+img.id+'" title="\u5220\u9664">\u{1F5D1}</button></div>':'';
        return '<div class="grid-item" data-id="'+img.id+'">'+vis
            +'<div class="grid-img-shell"><img src="'+esc(img.thumb_url||img.url)+'" alt="'+esc(title)+'" loading="lazy"></div>'
            +'<div class="grid-overlay"><div class="overlay-model">'+esc(img.title||img.model||'')+'</div>'
            +'<div class="overlay-prompt">'+esc(img.prompt||'')+'</div>'
            +'<div class="overlay-likes">\u2764\uFE0F '+(img.likes_count||0)+' \u00B7 \u6D4F\u89C8 '+views+'</div></div>'
            +'<div class="grid-card-info"><div class="grid-author"><img src="'+esc(avatar)+'" alt="" onerror="this.src=\'/api/gallery/gen-avatar/'+(esc(img.username)||'u')+'\'"><span>'+esc(author)+'</span></div>'
            +'<div class="grid-card-title">'+esc(title)+'</div>'
            +'<div class="grid-card-stats"><span class="view-stat">'+views+' \u6B21\u6D4F\u89C8</span><span>\u2661 '+(img.likes_count||0)+'</span><span>\u21E9 '+(img.download_count||0)+'</span><span>\u25CC '+(img.comments_count||0)+'</span></div></div>'
            +mgmt+'</div>';}).join('');
    container.querySelectorAll('.grid-item').forEach(function(it){
        it.onclick=function(e){
            if(e.target.closest('.gm-btn'))return;
            var im=images.find(function(i){return i.id===+it.dataset.id;});if(im)showPreview(im);};
    });
    // 管理按钮事件
    if(showManage){
        container.querySelectorAll('.gm-del').forEach(function(b){
            b.onclick=function(e){e.stopPropagation();customConfirm('\u786E\u5B9A\u5220\u9664\u8FD9\u5F20\u56FE\u7247\uFF1F\u5220\u9664\u540E\u65E0\u6CD5\u6062\u590D\u3002').then(function(ok){if(ok)myDeleteImage(+b.dataset.id);});};});
        container.querySelectorAll('.gm-vis').forEach(function(b){
            b.onclick=function(e){e.stopPropagation();myToggleVis(+b.dataset.id);};});
        container.querySelectorAll('.gm-edit').forEach(function(b){
            b.onclick=function(e){e.stopPropagation();myEditTitle(+b.dataset.id,b.dataset.title);};});
    }
}

function updateViewBadges(imageId,count){
    document.querySelectorAll('.grid-item[data-id="'+imageId+'"] .view-stat').forEach(function(el){
        el.textContent=(Number(count)||0)+' \u6B21\u6D4F\u89C8';
    });
    document.querySelectorAll('.grid-item[data-id="'+imageId+'"] .overlay-likes').forEach(function(el){
        var img=state.images.find(function(i){return i.id===imageId;})||state.currentPreview||{};
        el.textContent='\u2764\uFE0F '+(img.likes_count||0)+' \u00B7 \u6D4F\u89C8 '+(Number(count)||0);
    });
}

async function recordView(img){
    if(!img||!img.id)return;
    try{
        var r=await fetch('/api/gallery/view/'+img.id,{method:'POST'});
        if(!r.ok)return;
        var d=await r.json();
        if(d.success){
            img.view_count=d.view_count||0;
            state.images.forEach(function(item){if(item.id===img.id)item.view_count=img.view_count;});
            updateViewBadges(img.id,img.view_count);
        }
    }catch(e){console.error(e);}
}
function renderPages(){
    if(state.totalPages<=1){E.pagination.innerHTML='';return;}
    var h='<button class="page-btn" id="prevP" '+(state.currentPage<=1?'disabled':'')+'>\u2039</button>';
    var mx=5,s=Math.max(1,state.currentPage-2),e=Math.min(state.totalPages,s+mx-1);
    if(e-s<mx-1)s=Math.max(1,e-mx+1);
    if(s>1){h+='<button class="page-btn" data-p="1">1</button>';if(s>2)h+='<span class="page-ellipsis">\u2026</span>';}
    for(var i=s;i<=e;i++)h+='<button class="page-btn '+(i===state.currentPage?'active':'')+'" data-p="'+i+'">'+i+'</button>';
    if(e<state.totalPages){if(e<state.totalPages-1)h+='<span class="page-ellipsis">\u2026</span>';h+='<button class="page-btn" data-p="'+state.totalPages+'">'+state.totalPages+'</button>';}
    h+='<button class="page-btn" id="nextP" '+(state.currentPage>=state.totalPages?'disabled':'')+'>\u203A</button>';
    E.pagination.innerHTML=h;
    E.pagination.querySelectorAll('[data-p]').forEach(function(b){b.onclick=function(){state.currentPage=+b.dataset.p;loadImages();};});
    var p=el('prevP'),n=el('nextP');
    if(p)p.onclick=function(){if(state.currentPage>1){state.currentPage--;loadImages();}};
    if(n)n.onclick=function(){if(state.currentPage<state.totalPages){state.currentPage++;loadImages();}};
}
async function loadImages(){
    setLoading(true);
    try{var r=await fetch('/api/gallery/images?page='+state.currentPage+'&sort='+state.sort);
        var d=await r.json();state.images=d.data||[];state.totalPages=d.total_pages||1;
        renderGrid(state.images,E.grid);renderPages();
    }catch(e){console.error(e);E.empty.hidden=false;}finally{setLoading(false);}
}
async function loadLiked(){
    if(!state.fingerprint)return;
    try{var r=await fetch('/api/gallery/liked?fingerprint='+encodeURIComponent(state.fingerprint));
        if(r.ok){var d=await r.json();state.likedIds=new Set(d.liked_ids||[]);}}catch(e){console.error(e);}
}
async function toggleLike(id){
    try{var r=await fetch('/api/gallery/like/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fingerprint:state.fingerprint})});
        if(r.ok){var d=await r.json();if(d.liked){state.likedIds.add(id);}else{state.likedIds.delete(id);}
            if(state.currentPreview&&state.currentPreview.id===id){
                E.pvLikeBtn.classList.toggle('liked',d.liked);
                E.pvLikeBtn.querySelector('.like-icon').textContent=d.liked?'\u2764\uFE0F':'\u{1F90D}';
                // 即时数字动画
                E.pvLikes.textContent=d.likes_count||0;
                E.pvLikeBtn.classList.add('pop');setTimeout(function(){E.pvLikeBtn.classList.remove('pop');},400);
                state.currentPreview.likes_count=d.likes_count;
            }loadImages();}}catch(e){console.error(e);}
}
function showPreview(img){
    state.currentPreview=img;E.pvImg.src=img.url;E.pvModel.textContent=img.model||'';
    recordView(img);
    E.pvNickname.textContent=img.title||'\u65E0\u6807\u9898';
    // #ID 和 @用户名 分两行
    E.pvUid.innerHTML='<a href="/gallery/image/'+(img.public_id||img.id)+'" style="color:var(--primary);text-decoration:none">#'+(img.public_id||img.id)+'</a>'
        +(img.username?'<br><a href="/gallery/user/'+esc(img.username)+'" style="color:var(--text-mute);text-decoration:none">@'+esc(img.username)+'</a>':'');
    E.pvPid.textContent='';
    E.pvDate.textContent=fmtDate(img.created_at);E.pvPrompt.textContent=img.prompt||'';
    E.pvLikes.textContent=img.likes_count||0;E.pvDownload.href=img.url;E.pvDownload.download=(img.title||'image_'+(img.public_id||img.id))+'.png';
    var liked=state.likedIds.has(img.id);E.pvLikeBtn.classList.toggle('liked',liked);
    E.pvLikeBtn.querySelector('.like-icon').textContent=liked?'\u2764\uFE0F':'\u{1F90D}';
    E.pvAvatar.src=img.avatar_url||'/api/gallery/gen-avatar/'+(img.username||'u');E.pvAvatar.onerror=function(){this.src='/api/gallery/gen-avatar/'+(img.username||'u');this.onerror=null;};E.pvAvatar.style.display='';
    if(state.token){E.commentInput.hidden=false;E.commentLoginHint.hidden=true;}
    else{E.commentInput.hidden=true;E.commentLoginHint.hidden=false;}
    loadComments(img.id);
    E.pvModal.classList.add('show');document.body.style.overflow='hidden';
}
function closePreview(){E.pvModal.classList.remove('show');document.body.style.overflow='';state.currentPreview=null;}
async function login(u,p){
    try{var r=await fetch('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
        var d=await r.json();
        if(d.success&&d.token){
            state.token=d.token;localStorage.setItem('token',d.token);
            // 登录接口直接返回用户信息，无需额外 verify
            var usr=d.user||{};
            state.username=usr.username||u;state.isAdmin=usr.is_admin||false;
            localStorage.setItem('username',state.username);localStorage.setItem('is_admin',String(state.isAdmin));
            closeLg();renderUser();loadImages();
        }else{E.lgError.textContent=d.message||'\u767B\u5F55\u5931\u8D25';E.lgError.hidden=false;}
    }catch(e){E.lgError.textContent='\u7F51\u7EDC\u9519\u8BEF';E.lgError.hidden=false;}
}
function closeLg(){E.lgModal.classList.remove('show');document.body.style.overflow='';E.lgForm.reset();E.lgError.hidden=true;}
function logout(){state.token=null;state.username=null;state.isAdmin=false;
    localStorage.removeItem('token');localStorage.removeItem('username');localStorage.removeItem('is_admin');
    renderUser();if(state.viewingMy)backToGal();loadImages();}
async function showMy(){
    if(!state.token)return;state.viewingMy=true;E.grid.style.display='none';E.pagination.style.display='none';E.uc.hidden=false;
    setLoading(true);
    try{
        // 加载用户资料
        var pr=await fetch('/api/gallery/profile',{headers:{Authorization:'Bearer '+state.token}});
        if(pr.ok){var pd=await pr.json();if(pd.success){var p=pd.data;
            E.ucNickname.textContent=p.nickname||p.username;E.ucUid.textContent='@'+p.username;
            E.ucAvatar.src=p.avatar_url||'/api/gallery/gen-avatar/'+(p.username||'u');E.ucAvatar.onerror=function(){this.src='/api/gallery/gen-avatar/'+(p.username||'u');this.onerror=null;};E.ucImgCount.textContent=p.total_images||0;
            E.ucLikeCount.textContent=p.total_likes||0;
            E.ucNickInput.value=p.nickname||'';E.ucAvatarInput.value=p.avatar_url||'';
            E.ucBio.textContent=p.bio||'';E.ucBioInput.value=p.bio||'';
            E.ucHomeLink.innerHTML='\u{1F517} \u4F60\u7684\u4E3B\u9875\uFF1A<a href="/gallery/user/'+esc(p.username)+'">'+location.origin+'/gallery/user/'+esc(p.username)+'</a>';
            // 显示编辑按钮
            E.ucEditBtn.hidden=false;E.ucAvatarEdit.hidden=false;}}
        // 加载我的图片（带管理按钮）
        var r=await fetch('/api/gallery/my',{headers:{Authorization:'Bearer '+state.token}});
        if(r.ok){var d=await r.json();renderGrid(d.data||[],E.myGrid,true);}
    }catch(e){console.error(e);}finally{setLoading(false);}
}
function backToGal(){state.viewingMy=false;E.uc.hidden=true;E.grid.style.display='';E.pagination.style.display='';E.ucEdit.hidden=true;loadImages();}
async function saveProfile(){
    try{var r=await fetch('/api/gallery/profile',{method:'PUT',headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},
        body:JSON.stringify({nickname:E.ucNickInput.value,avatar_url:E.ucAvatarInput.value,bio:E.ucBioInput.value})});
        if(r.ok){E.ucEdit.hidden=true;showMy();}}catch(e){console.error(e);}
}
async function myDeleteImage(id){
    try{var r=await fetch('/api/gallery/my/delete/'+id,{method:'POST',headers:{Authorization:'Bearer '+state.token}});
        if(r.ok){showMy();}else{var d=await r.json();alert(d.detail||'\u5220\u9664\u5931\u8D25');}}catch(e){console.error(e);}
}
async function myToggleVis(id){
    try{var r=await fetch('/api/gallery/my/visibility/'+id,{method:'POST',headers:{Authorization:'Bearer '+state.token}});
        if(r.ok){showMy();}else{var d=await r.json();alert(d.detail||'\u64CD\u4F5C\u5931\u8D25');}}catch(e){console.error(e);}
}
function myEditTitle(id,currentTitle){
    var o=document.createElement('div');o.className='confirm-overlay';
    o.innerHTML='<div class="confirm-box"><p style="font-weight:600;margin-bottom:12px">\u270F\uFE0F \u7F16\u8F91\u6807\u9898</p>'
        +'<input type="text" class="pg-input" id="editTitleInput" value="'+esc(currentTitle)+'" maxlength="100" placeholder="\u8F93\u5165\u56FE\u7247\u6807\u9898..." style="width:100%;margin-bottom:16px;box-sizing:border-box">'
        +'<div class="confirm-btns"><button class="btn" id="etCancel">\u53D6\u6D88</button><button class="btn btn-primary" id="etSave">\u4FDD\u5B58</button></div></div>';
    document.body.appendChild(o);
    var inp=o.querySelector('#editTitleInput');inp.focus();inp.select();
    o.querySelector('#etCancel').onclick=function(){o.remove();};
    o.querySelector('#etSave').onclick=async function(){
        var t=(inp.value||'').trim();
        try{var r=await fetch('/api/gallery/my/title/'+id,{method:'POST',
            headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},
            body:JSON.stringify({title:t})});
            var d=await r.json();if(d.success){o.remove();showMy();}
            else{alert(d.detail||'\u4FDD\u5B58\u5931\u8D25');}
        }catch(e){alert('\u64CD\u4F5C\u5931\u8D25');}
    };
    inp.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();o.querySelector('#etSave').click();}};
}
async function loadComments(imageId){
    E.commentList.innerHTML='';E.commentCount.textContent='';
    // 判断当前登录用户是否是图片作者 / 管理员
    var myId=null;
    if(state.token){try{var tk=state.token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/');var pl=JSON.parse(atob(tk));myId=(pl.id!=null)?pl.id:null;}catch(e){}}
    var isOwner=state.currentPreview&&state.currentPreview.user_id!=null&&myId!=null&&state.currentPreview.user_id===myId;
    try{var r=await fetch('/api/gallery/comments/'+imageId+'?sort='+state.commentSort);var d=await r.json();
        E.commentCount.textContent=d.total||0;
        // 渲染排序选择器
        var sortHtml='<div class="comment-sort"><button class="cs-btn'+(state.commentSort==='newest'?' active':'')+'" data-cs="newest">\u{1F552} \u6700\u65B0</button>'
            +'<button class="cs-btn'+(state.commentSort==='likes'?' active':'')+'" data-cs="likes">\u{1F525} \u6700\u70ED</button></div>';
        if(d.data&&d.data.length){E.commentList.innerHTML=sortHtml+d.data.map(function(c){
            var pinCls=c.is_pinned?'pinned':'';
            var pinLabel=c.is_pinned?'<span class="ca-pin">\u{1F4CC}\u7F6E\u9876</span>':'';
            var isMine=myId!=null&&c.user_id===myId;
            var canManage=isOwner||state.isAdmin;
            var actions='<div class="comment-actions">'
                +'<button class="ca-btn ca-like" data-cid="'+c.id+'">\u2764 '+(c.likes_count||0)+'</button>';
            if(canManage){
                actions+='<button class="ca-btn ca-pin-btn" data-cid="'+c.id+'" title="'+(c.is_pinned?'\u53D6\u6D88\u7F6E\u9876':'\u7F6E\u9876')+'">'+(c.is_pinned?'\u{1F4CC}':'\u{1F4CC}')+'</button>';
                actions+='<button class="ca-btn ca-del" data-cid="'+c.id+'" title="\u5220\u9664">\u{1F5D1}\uFE0F</button>';
            } else if(isMine){
                actions+='<button class="ca-btn ca-del" data-cid="'+c.id+'" title="\u5220\u9664">\u{1F5D1}\uFE0F</button>';
            }
            actions+='</div>';
            var avatarUrl=c.avatar_url||'/api/gallery/gen-avatar/'+(c.username||'u');
            return '<div class="comment-item '+pinCls+'">'+pinLabel+'<img class="comment-avatar" src="'+esc(avatarUrl)+'" alt="" onerror="this.src=\'/api/gallery/gen-avatar/'+(esc(c.username)||'u')+'\'">'
                +'<div class="comment-body"><div class="comment-head"><span class="comment-nick">'+esc(c.nickname||c.username)+'</span>'
                +'<span class="comment-time">'+fmtDate(c.created_at)+'</span></div>'
                +'<div class="comment-text">'+esc(c.content)+'</div>'+actions+'</div></div>';}).join('');
            // 绑定排序切换事件
            E.commentList.querySelectorAll('.cs-btn').forEach(function(b){
                b.onclick=function(){state.commentSort=b.dataset.cs;loadComments(imageId);};});
            // 绑定事件
            E.commentList.querySelectorAll('.ca-like').forEach(function(b){
                b.onclick=function(){likeComment(+b.dataset.cid,imageId);};});
            E.commentList.querySelectorAll('.ca-pin-btn').forEach(function(b){
                b.onclick=function(){pinComment(+b.dataset.cid,imageId);};});
            E.commentList.querySelectorAll('.ca-del').forEach(function(b){
                b.onclick=function(){customConfirm('\u786E\u5B9A\u5220\u9664\u8FD9\u6761\u8BC4\u8BBA\uFF1F').then(function(ok){if(ok)delComment(+b.dataset.cid,imageId);});};});
        }else{E.commentList.innerHTML='<div style="text-align:center;color:var(--text-mute);padding:16px;font-size:13px">\u6682\u65E0\u8BC4\u8BBA</div>';}
    }catch(e){console.error(e);}
}
async function likeComment(cid,imgId){
    try{await fetch('/api/gallery/comment/like/'+cid,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({fingerprint:state.fingerprint})});loadComments(imgId);}catch(e){console.error(e);}
}
async function pinComment(cid,imgId){
    try{await fetch('/api/gallery/comment/pin/'+cid,{method:'POST',headers:{Authorization:'Bearer '+state.token}});loadComments(imgId);}catch(e){console.error(e);}
}
async function delComment(cid,imgId){
    try{await fetch('/api/gallery/comment/delete/'+cid,{method:'POST',headers:{Authorization:'Bearer '+state.token}});loadComments(imgId);}catch(e){console.error(e);}
}
async function submitComment(){
    if(!state.currentPreview||!state.token)return;
    var text=(E.commentText.value||'').trim();if(!text)return;
    try{var r=await fetch('/api/gallery/comments/'+state.currentPreview.id,{method:'POST',
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+state.token},
        body:JSON.stringify({content:text})});
        var d=await r.json();if(d.success){E.commentText.value='';loadComments(state.currentPreview.id);}
        else{alert(d.detail||'\u8BC4\u8BBA\u5931\u8D25');}
    }catch(e){console.error(e);}
}
function bindEvents(){
    E.sortBtns.forEach(function(b){b.onclick=function(){state.sort=b.dataset.sort;state.currentPage=1;
        E.sortBtns.forEach(function(x){x.classList.toggle('active',x.dataset.sort===state.sort);});loadImages();};});
    E.viewBtns.forEach(function(b){b.onclick=function(){state.viewMode=b.dataset.view;
        E.viewBtns.forEach(function(x){x.classList.toggle('active',x.dataset.view===state.viewMode);});
        E.grid.classList.toggle('list-view',state.viewMode==='list');};});
    E.pvClose.onclick=closePreview;E.pvModal.querySelector('.modal-backdrop').onclick=closePreview;
    E.pvLikeBtn.onclick=function(){if(state.currentPreview)toggleLike(state.currentPreview.id);};
    E.lgClose.onclick=closeLg;E.lgModal.querySelector('.modal-backdrop').onclick=closeLg;
    E.lgForm.onsubmit=function(e){e.preventDefault();login(el('username').value,el('password').value);};
    // User center
    E.ucBackBtn.onclick=backToGal;
    E.ucEditBtn.onclick=function(){E.ucEdit.hidden=!E.ucEdit.hidden;};
    E.ucAvatarEdit.onclick=function(){E.ucEdit.hidden=false;};
    E.ucSaveBtn.onclick=saveProfile;
    // Comments
    E.commentSubmit.onclick=submitComment;
    E.commentText.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitComment();}};
    // Search
    E.searchGo.onclick=doSearch;
    E.searchInput.onkeydown=function(e){if(e.key==='Enter')doSearch();};
    document.onkeydown=function(e){if(e.key==='Escape'){if(E.pvModal.classList.contains('show'))closePreview();
        else if(E.lgModal.classList.contains('show'))closeLg();}};
}
async function init(){
    state.fingerprint=genFP();
    // 验证 token 有效性，过期/无效就清理
    if(state.token){
        try{var vr=await fetch('/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:state.token})});
            var vd=await vr.json();
            if(!vd.success){state.token=null;state.username=null;state.isAdmin=false;
                localStorage.removeItem('token');localStorage.removeItem('username');localStorage.removeItem('is_admin');}
        }catch(e){state.token=null;state.username=null;state.isAdmin=false;
            localStorage.removeItem('token');localStorage.removeItem('username');localStorage.removeItem('is_admin');}
    }
    renderUser();bindEvents();
    // 先加载点赞状态，再渲染页面（解决详情页点赞显示异常）
    await loadLiked();

    var galEl=document.querySelector('.gal');
    var detailId=galEl?+galEl.dataset.detailId:0;
    var userPage=galEl?galEl.dataset.userPage:'';

    if(detailId){
        try{var r=await fetch('/api/gallery/detail/'+detailId);var d=await r.json();
            if(d.success){renderDetailPage(d.data);}
            else{E.empty.hidden=false;E.empty.querySelector('p').textContent='\u56FE\u7247\u4E0D\u5B58\u5728';}
        }catch(e){console.error(e);E.empty.hidden=false;}
    } else if(userPage){
        await loadUserPage(userPage);
    } else {
        await loadImages();
    }
}

function renderDetailPage(img){
    E.grid.style.display='none';E.pagination.style.display='none';
    document.querySelector('.gal-header').style.display='none';
    state.currentPreview=img;

    var detail=document.createElement('div');detail.className='detail-page';
    var liked=state.likedIds.has(img.id);
    var hasToken=!!state.token;

    detail.innerHTML='<div class="detail-layout">'
        +'<div class="detail-img-col"><img src="'+esc(img.url)+'" alt="" class="detail-img"></div>'
        +'<div class="detail-info-col">'
        +'<h1 class="detail-title">'+esc(img.title||'\u65E0\u6807\u9898')+'</h1>'
        +'<div class="detail-meta"><a href="/gallery/image/'+(img.public_id||img.id)+'" style="color:var(--primary)">#'+(img.public_id||img.id)+'</a><br>'
        +(img.username?'<a href="/gallery/user/'+esc(img.username)+'" style="color:var(--text-soft);text-decoration:none">@'+esc(img.username)+'</a> \u00B7 ':'')
        +fmtDate(img.created_at)+'</div>'
        +'<div class="detail-stats">\u2764\uFE0F '+(img.likes_count||0)+' \u00B7 \u{1F4AC} '+(img.comments_count||0)+' \u00B7 \u{1F441} '+(img.view_count||0)+'</div>'
        +'<div class="detail-model">\u6A21\u578B\uFF1A'+esc(img.model||'')+'</div>'
        +'<div class="detail-size">\u5C3A\u5BF8\uFF1A'+(img.width||0)+' \u00D7 '+(img.height||0)+' \u00B7 '+((img.file_size||0)/1024).toFixed(1)+'KB</div>'
        +'<p class="detail-prompt">'+esc(img.prompt||'')+'</p>'
        +'<div class="detail-actions">'
        +'<button class="like-btn'+(liked?' liked':'')+'" id="detailLikeBtn"><span class="like-icon">'+(liked?'\u2764\uFE0F':'\u{1F90D}')+'</span><span class="like-count" id="detailLikeCount">'+(img.likes_count||0)+'</span></button>'
        +'<a class="btn btn-primary" href="'+esc(img.url)+'" download="'+(esc(img.title)||'image')+'.png">\u2B07\uFE0F \u4E0B\u8F7D</a>'
        +'<a class="btn" href="/gallery">\u2190 \u8FD4\u56DE\u5E7F\u573A</a></div>'
        +'<div class="pv-comments"><h4>\u{1F4AC} \u8BC4\u8BBA <span class="d-comment-count">0</span></h4>'
        +'<div class="d-comment-list"></div>'
        +'<div class="comment-input d-comment-input"'+(hasToken?'':' hidden')+'><textarea class="pg-input d-comment-text" rows="2" placeholder="\u5199\u4E0B\u4F60\u7684\u8BC4\u8BBA..." maxlength="500"></textarea><button class="btn btn-primary d-comment-submit">\u53D1\u8868</button></div>'
        +'<div class="comment-login-hint d-comment-login-hint"'+(hasToken?' hidden':'')+'>\u767B\u5F55\u540E\u5373\u53EF\u8BC4\u8BBA</div>'
        +'</div></div></div>';

    document.querySelector('.gal').appendChild(detail);

    // 用 detail.querySelector 获取子元素，避免 ID 冲突
    detail.querySelector('#detailLikeBtn').onclick=function(){toggleLike(img.id);};
    var dSubmit=detail.querySelector('.d-comment-submit');
    var dText=detail.querySelector('.d-comment-text');
    if(dSubmit){
        dSubmit.onclick=function(){submitComment();};
        dText.onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submitComment();}};
    }
    E.commentList=detail.querySelector('.d-comment-list');
    E.commentCount=detail.querySelector('.d-comment-count');
    E.pvLikes=detail.querySelector('#detailLikeCount');
    E.pvLikeBtn=detail.querySelector('#detailLikeBtn');
    E.commentInput=detail.querySelector('.d-comment-input');
    E.commentText=dText;

    loadComments(img.id);
}

async function loadUserPage(username){
    setLoading(true);E.grid.style.display='none';E.pagination.style.display='none';E.uc.hidden=false;
    // 立即隐藏编辑相关元素（不等 API 响应）
    E.ucEditBtn.hidden=true;E.ucAvatarEdit.hidden=true;E.ucEdit.hidden=true;E.ucHomeLink.innerHTML='';
    try{var r=await fetch('/api/gallery/user/'+encodeURIComponent(username));
        if(r.ok){var d=await r.json();if(d.success){
            var p=d.profile;
            E.ucNickname.textContent=p.nickname||p.username;E.ucUid.textContent='@'+p.username;
            E.ucAvatar.src=p.avatar_url||'/api/gallery/gen-avatar/'+(p.username||'u');E.ucAvatar.onerror=function(){this.src='/api/gallery/gen-avatar/'+(p.username||'u');this.onerror=null;};E.ucImgCount.textContent=p.total_images||0;
            E.ucLikeCount.textContent=p.total_likes||0;
            E.ucBio.textContent=p.bio||'';
            // 封禁状态检测
            if(p.is_banned){
                E.myGrid.innerHTML='<div class="banned-notice"><span class="banned-icon">\u{1F6AB}</span><h3>\u8BE5\u7528\u6237\u5DF2\u88AB\u5C01\u7981</h3><p>\u5C01\u7981\u539F\u56E0\uFF1A'
                    +esc(p.ban_reason||'\u8FDD\u89C4\u64CD\u4F5C')+'</p></div>';
            }else{
                renderGrid(d.data||[],E.myGrid);
            }
        }}}catch(e){console.error(e);}finally{setLoading(false);}
}
document.readyState==='loading'?document.addEventListener('DOMContentLoaded',init):init();
})();
