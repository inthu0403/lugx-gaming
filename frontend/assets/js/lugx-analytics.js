class LugxAnalytics {
    constructor() {
        this.sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
        this.userId = this.getOrCreateUserId();
        this.endpoint = '/api/analytics';
        this.init();
        console.log('🎮 Lugx Analytics Active - Session:', this.sessionId);
    }
    
    getOrCreateUserId() {
        try {
            let id = localStorage.getItem('lugx_user_id');
            if (!id) {
                id = 'user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                localStorage.setItem('lugx_user_id', id);
            }
            return id;
        } catch (e) {
            return 'user_' + Date.now();
        }
    }
    
    init() {
        this.trackPageView();
        this.trackClicks();
        this.trackScroll();
    }
    
    trackPageView() {
        this.send('page_view', {
            page_url: window.location.href,
            page_path: window.location.pathname,
            page_title: document.title,
            referrer: document.referrer || 'direct'
        });
    }
    
    trackClicks() {
        document.addEventListener('click', (e) => {
            this.send('click_event', {
                element_tag: e.target.tagName.toLowerCase(),
                element_text: e.target.textContent?.trim().substring(0, 100),
                coordinates: { x: e.clientX, y: e.clientY }
            });
        });
    }
    
    trackScroll() {
        let timer = null;
        window.addEventListener('scroll', () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                const scrollTop = window.pageYOffset;
                const docHeight = document.documentElement.scrollHeight - window.innerHeight;
                const percent = Math.round((scrollTop / docHeight) * 100);
                
                if ([25, 50, 75, 100].includes(percent)) {
                    this.send('scroll_milestone', { milestone: percent });
                }
            }, 250);
        });
    }
    
    send(eventType, data) {
        fetch(this.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                session_id: this.sessionId,
                user_id: this.userId,
                event_type: eventType,
                page_path: window.location.pathname,
                page_url: window.location.href,
                timestamp: new Date().toISOString(),
                data: data
            }),
            keepalive: true
        }).then(r => {
            if (r.ok) console.log(`✅ ${eventType} tracked`);
        }).catch(e => console.warn(`⚠️ Analytics error: ${e.message}`));
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.lugxAnalytics = new LugxAnalytics();
});
