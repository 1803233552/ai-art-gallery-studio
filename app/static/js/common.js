/* ---- 浅夜の梦: Global Utilities ---- */

/* Dark mode */
(function(){
    const html = document.documentElement;
    const saved = localStorage.getItem('ai_dark');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if ((saved !== null ? saved === 'true' : prefersDark)) html.classList.add('dark');
})();

function toggleDark(){
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('ai_dark', String(isDark));
    // update all theme toggle buttons on the page
    document.querySelectorAll('.theme-toggle-icon').forEach(el => {
        el.textContent = isDark ? '☀️' : '🌙';
    });
}

/* Toast notification */
function showToast(msg, type = 'success'){
    let c = document.querySelector('.toast-container');
    if(!c){ c = document.createElement('div'); c.className='toast-container'; document.body.appendChild(c); }
    const t = document.createElement('div');
    t.className = 'toast ' + type;
    t.textContent = msg;
    c.appendChild(t);
    setTimeout(()=>{ t.style.animation='fadeOut .3s ease forwards'; setTimeout(()=>t.remove(),300); }, 3000);
}
window.showToast = showToast;
