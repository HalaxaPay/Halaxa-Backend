// ==================== PREMIUM ANIMATED SPA JAVASCRIPT ==================== //

// BACKEND URL CONFIGURATION - Use environment variable or fallback
const BACKEND_URL = import.meta.env?.VITE_BACKEND_URL || 'https://halaxa-backend.onrender.com';

document.addEventListener('DOMContentLoaded', function() {
    // Initialize the SPA navigation FIRST - this should always work
    initializeSPA();
    
    // Add interactive animations
    initializeAnimations();
    
    // Add floating particles animation
    initializeParticles();
    
    // Add interactive card effects
    initializeCardEffects();
    
    // Initialize user personalization AFTER SPA is ready (non-blocking)
    initializeUserPersonalization().catch(error => {
        console.warn('⚠️ User personalization failed, but SPA still works:', error);
        // Don't redirect to login immediately, let user navigate first
        // They can try to access protected features which will then redirect if needed
    });
});

// ==================== USER PERSONALIZATION ==================== //

async function initializeUserPersonalization() {
    try {
        console.log('🔄 Initializing user personalization...');
        
        // Try to import Supabase client for secure session handling
        let supabase, auth;
        try {
            const supabaseModule = await import('./supabase-client.js');
            supabase = supabaseModule.supabase;
            auth = supabaseModule.auth;
            console.log('✅ Supabase client loaded successfully');
        } catch (importError) {
            console.error('❌ Failed to import Supabase client:', importError);
            console.log('🔧 Navigation will work without authentication');
            return; // Exit gracefully, SPA navigation still works
        }
        
        // Check for active Supabase session (secure method)
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error) {
            console.error('Error getting session:', error);
            // Don't redirect immediately, let user try to navigate
            setTimeout(() => {
                if (!localStorage.getItem('userActive')) {
                    redirectToLogin();
                }
            }, 5000); // Give user 5 seconds to interact with the page
            return;
        }
        
        if (session?.user) {
            const userId = session.user.id;
            console.log('🔐 Secure session found for user:', userId.substring(0, 4) + '****');
            
            // Store minimal data in localStorage (not the full user ID)
            localStorage.setItem('userActive', 'true');
            
            // Update welcome message with user info
            updateWelcomeMessage(session.user);
            
            // Load personalized data for this user (non-blocking)
            loadPersonalizedData(userId, session.user).catch(error => {
                console.warn('⚠️ Failed to load personalized data:', error);
                // Continue anyway with basic session data
                updateDashboardWithUserData({}, session.user);
            });
            
            // Clean up URL (remove any lingering parameters)
            window.history.replaceState({}, document.title, window.location.pathname);
        } else {
            console.log('❌ No active session found');
            // Don't redirect immediately, let user try to navigate first
            setTimeout(() => {
                console.log('⏰ Session timeout - redirecting to login');
                redirectToLogin();
            }, 3000); // Give user 3 seconds to see the dashboard
        }
    } catch (error) {
        console.error('❌ Session initialization error:', error);
        // Don't redirect immediately on errors
        console.log('🔧 Continuing with basic functionality...');
        setTimeout(() => {
            if (!localStorage.getItem('userActive')) {
                redirectToLogin();
            }
        }, 5000);
    }
}

function redirectToLogin() {
    // Clear any stored authentication data
    localStorage.removeItem('userActive');
    localStorage.removeItem('user');
    localStorage.removeItem('userPlan');
    
    // Redirect to login page
    window.location.href = 'login.html';
}

function updateWelcomeMessage(user) {
    // Update welcome title to be more personalized
    const welcomeTitle = document.querySelector('.welcome-title');
    if (welcomeTitle && user) {
        const firstName = user.user_metadata?.first_name || user.email?.split('@')[0] || 'User';
        welcomeTitle.textContent = `Welcome back, ${firstName}!`;
    }
}

async function loadPersonalizedData(userId, user) {
    try {
        console.log('🔄 Loading personalized data securely...');
        
        // Try to use Supabase session token for API calls
        let supabase;
        try {
            const supabaseModule = await import('./supabase-client.js');
            supabase = supabaseModule.supabase;
        } catch (importError) {
            console.warn('⚠️ Could not import Supabase client for data loading:', importError);
            // Continue with basic user data
            updateDashboardWithUserData({}, user);
            return;
        }
        
        const { data: { session } } = await supabase.auth.getSession();
        
        if (!session) {
            console.log('❌ No session found - cannot load personalized data');
            // Don't redirect immediately, just update with basic user data
            updateDashboardWithUserData({}, user);
            return;
        }
        
        // Load user profile data using secure backend API
        try {
            console.log('📡 Attempting to fetch user profile...');
            const profileResponse = await fetch(`${BACKEND_URL}/api/account/profile`, {
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (profileResponse.ok) {
                const userData = await profileResponse.json();
                console.log('✅ User data loaded securely');
                
                // Update dashboard with user-specific information
                updateDashboardWithUserData(userData, user);
            } else {
                console.warn(`⚠️ Profile API call failed with status ${profileResponse.status}, using session data`);
                updateDashboardWithUserData({}, user);
            }
        } catch (apiError) {
            console.warn('⚠️ API error, using session data:', apiError);
            // Network error or backend down - continue with session data
            updateDashboardWithUserData({}, user);
        }
        
    } catch (error) {
        console.error('❌ Error loading personalized data:', error);
        // Continue with basic user data even if there's an error
        updateDashboardWithUserData({}, user);
    }
}

function updateDashboardWithUserData(userData, user) {
    // Update various dashboard elements with user-specific data
    
    // Update profile section if it exists
    const profileName = document.querySelector('.profile-name');
    if (profileName) {
        const firstName = userData.first_name || user.user_metadata?.first_name || '';
        const lastName = userData.last_name || user.user_metadata?.last_name || '';
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'User';
        profileName.textContent = displayName;
    }
    
    // Update email if shown
    const profileEmail = document.querySelector('.profile-email');
    if (profileEmail) {
        profileEmail.textContent = userData.email || user.email || '';
    }
    
    // Update plan information
    if (userData.plan) {
        updatePlanDisplay(userData.plan);
    }
    
    console.log('✅ Dashboard updated with secure user data');
}

// ==================== SPA NAVIGATION WITH SMOOTH TRANSITIONS ==================== //

function initializeSPA() {
    const navItems = document.querySelectorAll('.nav-item');
    const mobileNavItems = document.querySelectorAll('.mobile-nav-item');
    const pages = document.querySelectorAll('.page-content');
        
    console.log('Initializing SPA with', navItems.length, 'nav items,', mobileNavItems.length, 'mobile nav items and', pages.length, 'pages');
    
    // Handle desktop navigation
    navItems.forEach((item, index) => {
        item.addEventListener('click', function() {
            const targetPageId = this.getAttribute('data-page');
            console.log('Desktop navigation clicked:', targetPageId);
            
            // Animate navigation item selection
            animateNavSelection(item, navItems);
            animateMobileNavSelection(null, mobileNavItems, targetPageId);
            
            // Smooth page transition
            smoothPageTransition(targetPageId, pages);
        });
        
        // Add hover effect for desktop
        item.addEventListener('mouseenter', function() {
            if (!this.classList.contains('active')) {
                this.style.transform = 'translateX(8px)';
                this.style.background = 'rgba(16, 185, 129, 0.1)';
            }
        });
        
        item.addEventListener('mouseleave', function() {
            if (!this.classList.contains('active')) {
                this.style.transform = 'translateX(0)';
                this.style.background = 'transparent';
            }
        });
    });

    // Handle mobile navigation
    mobileNavItems.forEach((item, index) => {
        item.addEventListener('click', function() {
            const targetPageId = this.getAttribute('data-page');
            console.log('Mobile navigation clicked:', targetPageId);
            
            // Animate mobile navigation item selection
            animateMobileNavSelection(item, mobileNavItems);
            animateNavSelection(null, navItems, targetPageId);
            
            // Smooth page transition
            smoothPageTransition(targetPageId, pages);
        });

        // Add touch feedback for mobile
        item.addEventListener('touchstart', function() {
            this.style.transform = 'translateY(-1px) scale(0.98)';
        });

        item.addEventListener('touchend', function() {
            this.style.transform = '';
        });
    });
    
    // Make sure home page is active on load
    const homePage = document.getElementById('home-page');
    if (homePage) {
        homePage.classList.add('active-page');
    }
    
    // Add debugging function to global scope for testing
    window.testNavigation = function(pageId) {
        console.log('🧪 Testing navigation to:', pageId);
        const pages = document.querySelectorAll('.page-content');
        smoothPageTransition(pageId, pages);
        
        // Also update nav items
        const navItems = document.querySelectorAll('.nav-item');
        const mobileNavItems = document.querySelectorAll('.mobile-nav-item');
        animateNavSelection(null, navItems, pageId);
        animateMobileNavSelection(null, mobileNavItems, pageId);
    };
    
    console.log('🎮 Debug: Use testNavigation("page-id") in console to test navigation');
}

function animateNavSelection(selectedItem, allItems, targetPageId = null) {
    // Remove active class from all items
    allItems.forEach(item => {
        item.classList.remove('active');
    });
    
    // If no selectedItem provided, find it by targetPageId
    if (!selectedItem && targetPageId) {
        selectedItem = Array.from(allItems).find(item => 
            item.getAttribute('data-page') === targetPageId
        );
    }
    
    if (selectedItem) {
        // Add active class to selected item with animation
        selectedItem.classList.add('active');
        
        // Add a temporary shine effect
        selectedItem.style.animation = 'activeItemGlow 0.6s ease-out';
        
        setTimeout(() => {
            selectedItem.style.animation = '';
        }, 600);
    }
}

function animateMobileNavSelection(selectedItem, allItems, targetPageId = null) {
    // Remove active class from all items
    allItems.forEach(item => {
        item.classList.remove('active');
    });
    
    // If no selectedItem provided, find it by targetPageId
    if (!selectedItem && targetPageId) {
        selectedItem = Array.from(allItems).find(item => 
            item.getAttribute('data-page') === targetPageId
        );
    }
    
    if (selectedItem) {
        // Add active class to selected item with animation
        selectedItem.classList.add('active');
        
        // Add a temporary bounce effect for mobile
        selectedItem.style.animation = 'mobileItemBounce 0.4s ease-out';
        
        setTimeout(() => {
            selectedItem.style.animation = '';
        }, 400);
    }
}

function smoothPageTransition(targetPageId, allPages) {
    const currentPage = document.querySelector('.page-content.active-page');
    const targetPage = document.getElementById(targetPageId);
    
    if (currentPage === targetPage) return;
    
    // Exit animation for current page
    if (currentPage) {
        currentPage.style.animation = 'pageSlideOut 0.3s ease-in-out forwards';
        
        setTimeout(() => {
            currentPage.classList.remove('active-page');
            currentPage.style.animation = '';
            
            // Enter animation for target page
            targetPage.classList.add('active-page');
            targetPage.style.animation = 'pageSlideIn 0.5s ease-out forwards';
            
            setTimeout(() => {
                targetPage.style.animation = '';
            }, 500);
        }, 300);
    } else {
        // First load
        targetPage.classList.add('active-page');
    }
}

// ==================== INTERACTIVE ANIMATIONS ==================== //

function initializeAnimations() {
    // Add CSS animations for page transitions
    const style = document.createElement('style');
    style.textContent = `
        @keyframes pageSlideOut {
            0% {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
            100% {
                opacity: 0;
                transform: translateY(-20px) scale(0.98);
            }
        }
        
        @keyframes pageSlideIn {
            0% {
                opacity: 0;
                transform: translateY(30px) scale(0.98);
            }
            100% {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }
        
        @keyframes cardHover {
            0% { transform: translateY(0) scale(1); }
            100% { transform: translateY(-8px) scale(1.02); }
        }
        
        @keyframes iconSpin {
            0% { transform: rotate(0deg) scale(1); }
            50% { transform: rotate(180deg) scale(1.1); }
            100% { transform: rotate(360deg) scale(1); }
        }
        
        @keyframes shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(100%); }
        }
        
        @keyframes mobileItemBounce {
            0% { transform: translateY(0) scale(1); }
            50% { transform: translateY(-4px) scale(1.05); }
            100% { transform: translateY(0) scale(1); }
        }
    `;
    document.head.appendChild(style);
    
    // Add hover effects to navigation items
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('mouseenter', function() {
            const icon = this.querySelector('i');
            if (icon && !this.classList.contains('active')) {
                icon.style.animation = 'iconSpin 0.6s ease-in-out';
                setTimeout(() => {
                    icon.style.animation = '';
                }, 600);
            }
        });
    });
}

// ==================== FLOATING PARTICLES SYSTEM ==================== //

function initializeParticles() {
    const particlesContainer = document.querySelector('.floating-particles');
    
    // Create additional particles dynamically
    for (let i = 0; i < 12; i++) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.animationDelay = Math.random() * 15 + 's';
        particle.style.animationDuration = (15 + Math.random() * 10) + 's';
        particlesContainer.appendChild(particle);
    }
    
    // Add interactive particle effects on mouse move
    document.addEventListener('mousemove', function(e) {
        createInteractiveParticle(e.clientX, e.clientY);
    });
}

function createInteractiveParticle(x, y) {
    // Throttle particle creation
    if (Math.random() > 0.98) {
        const particle = document.createElement('div');
        particle.style.position = 'fixed';
        particle.style.left = x + 'px';
        particle.style.top = y + 'px';
        particle.style.width = '2px';
        particle.style.height = '2px';
        particle.style.background = 'var(--accent-primary)';
        particle.style.borderRadius = '50%';
        particle.style.pointerEvents = 'none';
        particle.style.zIndex = '1000';
        particle.style.opacity = '0.6';
        particle.style.animation = 'floatParticle 2s ease-out forwards';
        
        document.body.appendChild(particle);
        
        setTimeout(() => {
            particle.remove();
        }, 2000);
    }
}

// ==================== INTERACTIVE CARD EFFECTS ==================== //

function initializeCardEffects() {
    // Stat cards interactive effects
    const statCards = document.querySelectorAll('.stat-card');
    statCards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.animation = 'cardHover 0.3s ease-out forwards';
            
            // Animate the icon
            const icon = this.querySelector('.stat-icon i');
            if (icon) {
                icon.style.animation = 'iconSpin 0.5s ease-in-out';
            }
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.animation = '';
            
            const icon = this.querySelector('.stat-icon i');
            if (icon) {
                icon.style.animation = '';
            }
        });
        
        // Add click effect
        card.addEventListener('click', function() {
            this.style.animation = 'cardPulse 0.3s ease-out';
            setTimeout(() => {
                this.style.animation = '';
            }, 300);
        });
    });
    
    // Balance card special effects
    const balanceCard = document.querySelector('.balance-card');
    if (balanceCard) {
        balanceCard.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-8px) scale(1.02)';
            this.style.boxShadow = 'var(--shadow-glow)';
        });
        
        balanceCard.addEventListener('mouseleave', function() {
            this.style.transform = '';
            this.style.boxShadow = '';
        });
    }
    
    // Chart container interactive effects
    const chartContainer = document.querySelector('.chart-container');
    if (chartContainer) {
        chartContainer.addEventListener('mouseenter', function() {
            const shimmer = this.querySelector('::before');
            this.style.animation = 'chartShimmer 1s ease-in-out';
        });
    }
    
    // Metric items hover effects
    const metricItems = document.querySelectorAll('.metric-item');
    metricItems.forEach(item => {
        item.addEventListener('mouseenter', function() {
            this.style.background = 'rgba(16, 185, 129, 0.05)';
            this.style.paddingLeft = 'var(--space-3)';
            this.style.borderRadius = 'var(--radius-md)';
            this.style.transform = 'translateX(5px)';
        });
        
        item.addEventListener('mouseleave', function() {
            this.style.background = '';
            this.style.paddingLeft = '';
            this.style.borderRadius = '';
            this.style.transform = '';
        });
    });
}

// ==================== INTERACTIVE BUTTON EFFECTS ==================== //

function initializeButtonEffects() {
    // Chart action buttons
    const chartActions = document.querySelectorAll('.chart-action, .balance-action');
    chartActions.forEach(button => {
        button.addEventListener('mouseenter', function() {
            this.style.transform = 'scale(1.1) rotate(5deg)';
            this.style.background = 'var(--accent-light)';
            this.style.color = 'var(--accent-primary)';
        });
        
        button.addEventListener('mouseleave', function() {
            this.style.transform = '';
            this.style.background = '';
            this.style.color = '';
        });
        
        button.addEventListener('click', function() {
            // Ripple effect
            const ripple = document.createElement('div');
            ripple.style.position = 'absolute';
            ripple.style.borderRadius = '50%';
            ripple.style.background = 'rgba(16, 185, 129, 0.3)';
            ripple.style.transform = 'scale(0)';
            ripple.style.animation = 'ripple 0.6s linear';
            ripple.style.left = '50%';
            ripple.style.top = '50%';
            ripple.style.width = '20px';
            ripple.style.height = '20px';
            ripple.style.marginLeft = '-10px';
            ripple.style.marginTop = '-10px';
            
            this.style.position = 'relative';
            this.appendChild(ripple);
            
            setTimeout(() => {
                ripple.remove();
            }, 600);
        });
    });
    
    // Add ripple animation
    const style = document.createElement('style');
    style.textContent = `
        @keyframes ripple {
            to {
                transform: scale(4);
                opacity: 0;
            }
        }
        
        @keyframes cardPulse {
            0% { transform: scale(1); }
            50% { transform: scale(1.05); }
            100% { transform: scale(1); }
        }
    `;
    document.head.appendChild(style);
}

// ==================== INITIALIZE ALL EFFECTS ==================== //

// Initialize all interactive effects when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    initializeButtonEffects();
    initializePlanUpgrades(); // Add upgrade functionality
    
    // Add smooth scrolling
    document.documentElement.style.scrollBehavior = 'smooth';
    
    // Add page load animation
    document.body.style.opacity = '0';
    document.body.style.transform = 'translateY(20px)';
    
    setTimeout(() => {
        document.body.style.transition = 'all 0.8s ease-out';
        document.body.style.opacity = '1';
        document.body.style.transform = 'translateY(0)';
    }, 100);
});

// ==================== PLAN UPGRADE FUNCTIONALITY ==================== //

function initializePlanUpgrades() {
    // Get upgrade buttons
    const proBtn = document.querySelector('.pro-btn');
    const eliteBtn = document.querySelector('.elite-btn');
    const basicBtn = document.querySelector('.basic-btn');

    // Add event listeners
    if (proBtn) {
        proBtn.addEventListener('click', () => handlePlanUpgrade('pro'));
    }
    if (eliteBtn) {
        eliteBtn.addEventListener('click', () => handlePlanUpgrade('elite'));
    }
    if (basicBtn) {
        basicBtn.addEventListener('click', () => handleBasicPlan());
    }

    // Check for upgrade success/cancel in URL
    checkUpgradeStatus();
    
    // Load current plan status
    loadCurrentPlanStatus();
}

async function handlePlanUpgrade(targetPlan) {
    try {
        // Check if user is logged in
        const token = localStorage.getItem('halaxa_token');
        if (!token) {
            showUpgradeNotification('Please login first to upgrade your plan', 'warning');
            return;
        }

        // Show loading state
        const button = document.querySelector(`.${targetPlan}-btn`);
        const originalText = button.innerHTML;
        button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
        button.disabled = true;

        // Get user email for checkout
        const userEmail = await getCurrentUserEmail();
        if (!userEmail) {
            throw new Error('Unable to get user email');
        }

        // Create Stripe checkout session
        const response = await fetch(`${BACKEND_URL}/api/stripe/create-checkout-session`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                plan: targetPlan,
                email: userEmail
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'Failed to create checkout session');
        }

        // Redirect to Stripe Checkout
        if (data.url) {
            window.location.href = data.url;
        } else {
            throw new Error('No checkout URL received');
        }

    } catch (error) {
        console.error('Upgrade error:', error);
        showUpgradeNotification(error.message || 'Failed to process upgrade', 'error');
        
        // Reset button
        const button = document.querySelector(`.${targetPlan}-btn`);
        button.innerHTML = targetPlan === 'pro' ? 'Upgrade to Pro <i class="fas fa-arrow-right"></i>' : 'Go Elite Now <i class="fas fa-arrow-right"></i>';
        button.disabled = false;
    }
}

async function getCurrentUserEmail() {
    try {
        const token = localStorage.getItem('halaxa_token');
        const response = await fetch(`${BACKEND_URL}/api/account/profile`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            return data.email;
        }
        return null;
    } catch (error) {
        console.error('Error getting user email:', error);
        return null;
    }
}

function handleBasicPlan() {
    // For basic plan, just show a message since it's free
    showUpgradeNotification('You are already on the Basic plan! Upgrade to Pro or Elite for more features.', 'info');
}

async function loadCurrentPlanStatus() {
    try {
        const token = localStorage.getItem('halaxa_token');
        if (!token) return;

        const response = await fetch(`${BACKEND_URL}/api/account/plan-status`, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.ok) {
            const data = await response.json();
            updatePlanDisplay(data.currentPlan);
        }
    } catch (error) {
        console.error('Error loading plan status:', error);
    }
}

function updatePlanDisplay(currentPlan) {
    // Update button states based on current plan
    const basicBtn = document.querySelector('.basic-btn');
    const proBtn = document.querySelector('.pro-btn');
    const eliteBtn = document.querySelector('.elite-btn');

    // Reset all buttons
    [basicBtn, proBtn, eliteBtn].forEach(btn => {
        if (btn) {
            btn.classList.remove('current-plan');
            btn.disabled = false;
        }
    });

    // Mark current plan
    switch (currentPlan) {
        case 'basic':
            if (basicBtn) {
                basicBtn.innerHTML = '<i class="fas fa-check"></i> Current Plan';
                basicBtn.classList.add('current-plan');
            }
            break;
        case 'pro':
            if (proBtn) {
                proBtn.innerHTML = '<i class="fas fa-check"></i> Current Plan';
                proBtn.classList.add('current-plan');
                proBtn.disabled = true;
            }
            break;
        case 'elite':
            if (eliteBtn) {
                eliteBtn.innerHTML = '<i class="fas fa-check"></i> Current Plan';
                eliteBtn.classList.add('current-plan');
                eliteBtn.disabled = true;
            }
            if (proBtn) {
                proBtn.style.opacity = '0.6';
                proBtn.disabled = true;
            }
            break;
    }
}

function checkUpgradeStatus() {
    const urlParams = new URLSearchParams(window.location.search);
    const upgradeStatus = urlParams.get('upgrade');
    const plan = urlParams.get('plan');

    if (upgradeStatus === 'success' && plan) {
        showUpgradeNotification(`🎉 Successfully upgraded to ${plan.toUpperCase()} plan!`, 'success');
        // Reload plan status
        setTimeout(() => {
            loadCurrentPlanStatus();
        }, 1000);
        
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
        
    } else if (upgradeStatus === 'cancelled') {
        showUpgradeNotification('Upgrade cancelled. You can try again anytime.', 'info');
        // Clean up URL
        window.history.replaceState({}, document.title, window.location.pathname);
    }
}

function showUpgradeNotification(message, type = 'info') {
    // Create notification element
    const notification = document.createElement('div');
    notification.className = `upgrade-notification ${type}`;
    
    const icon = type === 'success' ? 'check-circle' : 
                 type === 'error' ? 'exclamation-circle' :
                 type === 'warning' ? 'exclamation-triangle' : 'info-circle';
    
    notification.innerHTML = `
        <div class="notification-content">
            <i class="fas fa-${icon}"></i>
            <span>${message}</span>
            <button class="notification-close" onclick="this.parentElement.parentElement.remove()">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `;

    // Add styles if not already added
    if (!document.querySelector('#upgrade-notification-styles')) {
        const styles = document.createElement('style');
        styles.id = 'upgrade-notification-styles';
        styles.textContent = `
            .upgrade-notification {
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                max-width: 400px;
                border-radius: 8px;
                padding: 16px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
                animation: slideInRight 0.3s ease-out;
                font-family: 'Satoshi', sans-serif;
            }
            
            .upgrade-notification.success {
                background: linear-gradient(135deg, #10B981, #059669);
                color: white;
            }
            
            .upgrade-notification.error {
                background: linear-gradient(135deg, #EF4444, #DC2626);
                color: white;
            }
            
            .upgrade-notification.warning {
                background: linear-gradient(135deg, #F59E0B, #D97706);
                color: white;
            }
            
            .upgrade-notification.info {
                background: linear-gradient(135deg, #3B82F6, #2563EB);
                color: white;
            }
            
            .notification-content {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            
            .notification-content i:first-child {
                font-size: 20px;
                flex-shrink: 0;
            }
            
            .notification-close {
                background: none;
                border: none;
                color: inherit;
                cursor: pointer;
                padding: 4px;
                margin-left: auto;
                border-radius: 4px;
                transition: background-color 0.2s;
            }
            
            .notification-close:hover {
                background-color: rgba(255, 255, 255, 0.2);
            }
            
            .plan-cta-btn.current-plan {
                background: #10B981 !important;
                cursor: default;
            }
            
            @keyframes slideInRight {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
        `;
        document.head.appendChild(styles);
    }

    document.body.appendChild(notification);

    // Auto remove after 5 seconds
    setTimeout(() => {
        if (notification.parentNode) {
            notification.style.animation = 'slideInRight 0.3s ease-out reverse';
            setTimeout(() => notification.remove(), 300);
        }
    }, 5000);
}

// ==================== RESPONSIVE INTERACTIONS ==================== //

// Handle mobile interactions
function initializeMobileInteractions() {
    if (window.innerWidth <= 768) {
        // Add touch-friendly interactions
        const cards = document.querySelectorAll('.stat-card, .chart-card, .metrics-panel');
        cards.forEach(card => {
            card.addEventListener('touchstart', function() {
                this.style.transform = 'scale(0.98)';
            });
            
            card.addEventListener('touchend', function() {
                this.style.transform = '';
            });
        });
    }
}

// Initialize mobile interactions
window.addEventListener('resize', initializeMobileInteractions);
initializeMobileInteractions();
