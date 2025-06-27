// ==================== HALAXA ACCESS CONTROL INTEGRATION GUIDE ==================== //

/**
 * Integration examples for implementing access control in your existing frontend
 * Include this file after accessControl.js
 */

// ==================== PAYMENT LINK CREATION INTEGRATION ==================== //

/**
 * Example: Integrate access control with payment link creation form
 */
async function createPaymentLinkWithAccessControl(formData) {
  try {
    // Validate permissions before creating payment link
    const permission = await checkPaymentPermission({
      network: formData.network,
      amount: formData.amount
    });

    if (!permission.allowed) {
      // Show restriction message
      showAccessDeniedMessage(permission);
      return false;
    }

    // Permission granted, proceed with creation
    const paymentLink = await createPaymentLink(formData);
    return paymentLink;

  } catch (error) {
    console.error('Error creating payment link:', error);
    return false;
  }
}

/**
 * Example: Add access control to existing form submission
 */
function setupPaymentFormAccessControl() {
  const paymentForm = document.getElementById('payment-link-form');
  
  if (paymentForm) {
    paymentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const formData = new FormData(paymentForm);
      const paymentData = {
        network: formData.get('network'),
        amount: parseFloat(formData.get('amount')),
        title: formData.get('title')
      };

      // Check permissions
      const permission = await checkPaymentPermission(paymentData);
      
      if (!permission.allowed) {
        showRestrictionModal(permission);
        return;
      }

      // Continue with original form submission
      submitPaymentForm(paymentData);
    });
  }
}

// ==================== NETWORK SELECTION INTEGRATION ==================== //

/**
 * Example: Setup network restrictions in network selection UI
 */
function setupNetworkSelection() {
  const networkButtons = document.querySelectorAll('[data-network]');
  
  networkButtons.forEach(button => {
    const network = button.dataset.network;
    
    button.addEventListener('click', (e) => {
      if (!checkNetworkAccess(network)) {
        e.preventDefault();
        e.stopPropagation();
        
        const restriction = {
          message: `${network.toUpperCase()} network requires ${network === 'solana' ? 'Pro' : 'Elite'} plan.`,
          requiredPlan: network === 'solana' ? 'Pro' : 'Elite'
        };
        
        showUpgradePrompt(restriction);
        return false;
      }
      
      // Network is allowed, proceed with selection
      selectNetwork(network);
    });
  });
}

/**
 * Example: Dynamic network option rendering based on plan
 */
function renderNetworkOptions() {
  const networkContainer = document.getElementById('network-options');
  const userPlan = getUserPlan();
  
  const networks = [
    { 
      id: 'polygon', 
      name: 'Polygon', 
      icon: '⬠', 
      requiredPlan: 'basic',
      available: true 
    },
    { 
      id: 'solana', 
      name: 'Solana', 
      icon: '◎', 
      requiredPlan: 'pro',
      available: checkNetworkAccess('solana')
    },
    { 
      id: 'tron', 
      name: 'Tron', 
      icon: '▲', 
      requiredPlan: 'elite',
      available: checkNetworkAccess('tron')
    }
  ];

  networkContainer.innerHTML = networks.map(network => `
    <div class="network-option ${network.available ? '' : 'network-locked'}" 
         data-network="${network.id}"
         ${network.available ? '' : 'data-disabled="true"'}>
      
      <div class="network-icon">${network.icon}</div>
      <div class="network-name">${network.name}</div>
      
      ${!network.available ? `
        <div class="lock-overlay">
          <div class="lock-icon">🔒</div>
          <div class="upgrade-hint">
            Upgrade to ${network.requiredPlan.toUpperCase()}
          </div>
        </div>
      ` : ''}
    </div>
  `).join('');
}

// ==================== PAGE NAVIGATION INTEGRATION ==================== //

/**
 * Example: Protect navigation links
 */
function setupProtectedNavigation() {
  const navLinks = document.querySelectorAll('.nav-link, .sidebar-link');
  
  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    
    if (href && !checkPageAccess(href)) {
      link.classList.add('locked-nav-link');
      
      link.addEventListener('click', (e) => {
        e.preventDefault();
        showPageRestrictionModal(href);
      });
    }
  });
}

/**
 * Example: Setup page-level access control
 */
function initializePageAccessControl() {
  const currentPath = window.location.pathname;
  
  // Check if current page requires upgrade
  if (!checkPageAccess(currentPath)) {
    showPageUpgradeOverlay();
    return;
  }
  
  // Setup visual locks for current page elements
  applyPageSpecificLocks();
}

function applyPageSpecificLocks() {
  const userPlan = getUserPlan();
  
  // Capital page locks
  if (window.location.pathname.includes('/capital')) {
    if (userPlan === 'basic') {
      document.body.classList.add('page-restricted');
      showPageBanner('PRO', 'This feature requires Pro plan');
    }
  }
  
  // Orders page locks
  if (window.location.pathname.includes('/orders')) {
    if (userPlan !== 'elite') {
      document.body.classList.add('page-restricted');
      showPageBanner('ELITE', 'This feature requires Elite plan');
    }
  }
}

// ==================== UI HELPER FUNCTIONS ==================== //

function showRestrictionModal(restriction) {
  const modal = document.createElement('div');
  modal.className = 'access-restriction-modal';
  modal.innerHTML = `
    <div class="modal-content">
      <div class="restriction-icon">🚫</div>
      <h3>Access Restricted</h3>
      <p>${restriction.message}</p>
      
      ${restriction.reason === 'payment_link_limit' ? `
        <div class="usage-info">
          <p>Current usage: ${restriction.current}/${restriction.limit} payment links</p>
        </div>
      ` : ''}
      
      ${restriction.reason === 'volume_limit' ? `
        <div class="usage-info">
          <p>Monthly volume: ${restriction.current.toFixed(2)}/${restriction.limit} USDC</p>
        </div>
      ` : ''}
      
      <div class="modal-actions">
        <button class="btn-upgrade-plan" onclick="window.location.href='/plans.html'">
          Upgrade Plan
        </button>
        <button class="btn-close-modal" onclick="this.closest('.access-restriction-modal').remove()">
          Close
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Auto-remove after 10 seconds
  setTimeout(() => {
    if (modal.parentNode) {
      modal.remove();
    }
  }, 10000);
}

function showPageBanner(planType, message) {
  const banner = document.createElement('div');
  banner.className = `page-restriction-banner plan-${planType.toLowerCase()}`;
  banner.innerHTML = `
    <div class="banner-content">
      <div class="plan-badge badge-${planType.toLowerCase()}">${planType}</div>
      <span class="banner-message">${message}</span>
      <button class="btn-upgrade-small" onclick="window.location.href='/plans.html'">
        Upgrade
      </button>
    </div>
  `;
  
  document.body.insertBefore(banner, document.body.firstChild);
}

function showPageUpgradeOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'page-upgrade-overlay';
  overlay.innerHTML = `
    <div class="upgrade-content">
      <div class="upgrade-icon">🚀</div>
      <h2>Upgrade Required</h2>
      <p>This page requires a higher subscription plan.</p>
      <button class="btn-upgrade-now" onclick="window.location.href='/plans.html'">
        View Plans
      </button>
    </div>
  `;
  
  document.body.appendChild(overlay);
}

// ==================== USAGE MONITORING INTEGRATION ==================== //

/**
 * Example: Add usage displays to dashboard
 */
function setupUsageMonitoring() {
  const dashboardSidebar = document.querySelector('.dashboard-sidebar, .stats-panel');
  
  if (dashboardSidebar) {
    const usagePanel = document.createElement('div');
    usagePanel.className = 'usage-monitoring-panel';
    usagePanel.innerHTML = `
      <h4>Plan Usage</h4>
      <div class="payment-links-usage">Loading...</div>
      <div class="volume-usage">Loading...</div>
      <div class="plan-info">
        <span class="current-plan">Plan: ${getUserPlan().toUpperCase()}</span>
        <button class="btn-view-plans" onclick="window.location.href='/plans.html'">
          Manage Plan
        </button>
      </div>
    `;
    
    dashboardSidebar.appendChild(usagePanel);
  }
}

/**
 * Example: Real-time usage updates
 */
function updateUsageDisplays() {
  // This function is automatically called every 30 seconds by the access control system
  // You can also call it manually after specific actions
  
  // Update after payment link creation
  window.addEventListener('paymentLinkCreated', () => {
    setTimeout(() => {
      window.HalaxaAccessControl.updateUsageDisplay();
    }, 1000);
  });
  
  // Update after transaction completion
  window.addEventListener('transactionCompleted', () => {
    setTimeout(() => {
      window.HalaxaAccessControl.updateUsageDisplay();
    }, 1000);
  });
}

// ==================== FEATURE-SPECIFIC INTEGRATIONS ==================== //

/**
 * Example: Advanced analytics feature protection
 */
function setupAdvancedAnalytics() {
  const analyticsSection = document.querySelector('.advanced-analytics');
  
  if (analyticsSection) {
    const planInfo = getUserPlanInfo();
    
    if (!planInfo.features.advancedAnalytics) {
      analyticsSection.classList.add('feature-locked');
      analyticsSection.innerHTML = `
        <div class="feature-lock-overlay">
          <div class="lock-content">
            <h3>🔒 Advanced Analytics</h3>
            <p>Unlock detailed insights and reporting</p>
            <p>Available in Pro and Elite plans</p>
            <button class="btn-unlock-feature" onclick="window.location.href='/plans.html'">
              Upgrade to Pro
            </button>
          </div>
        </div>
      `;
    }
  }
}

/**
 * Example: Multiple wallets feature
 */
function setupMultipleWallets() {
  const addWalletButton = document.querySelector('.add-wallet-btn');
  
  if (addWalletButton) {
    const planInfo = getUserPlanInfo();
    
    if (!planInfo.features.multipleWallets) {
      addWalletButton.classList.add('feature-disabled');
      addWalletButton.addEventListener('click', (e) => {
        e.preventDefault();
        showFeatureRestriction('Multiple Wallets', 'Pro');
      });
    }
  }
}

function showFeatureRestriction(featureName, requiredPlan) {
  const notification = document.createElement('div');
  notification.className = 'feature-restriction-notification';
  notification.innerHTML = `
    <div class="notification-content">
      <strong>${featureName}</strong> requires ${requiredPlan} plan
      <button onclick="window.location.href='/plans.html'">Upgrade</button>
    </div>
  `;
  
  document.body.appendChild(notification);
  setTimeout(() => notification.remove(), 4000);
}

// ==================== INITIALIZATION ==================== //

/**
 * Initialize all access control integrations
 */
document.addEventListener('DOMContentLoaded', () => {
  // Wait for access control system to load
  setTimeout(() => {
    if (window.HalaxaAccessControl) {
      setupPaymentFormAccessControl();
      setupNetworkSelection();
      setupProtectedNavigation();
      initializePageAccessControl();
      setupUsageMonitoring();
      updateUsageDisplays();
      setupAdvancedAnalytics();
      setupMultipleWallets();
      
      console.log('🔐 Access control integrations initialized');
    }
  }, 1000);
});

// ==================== CUSTOM EVENT HANDLERS ==================== //

// Listen for plan changes
window.addEventListener('planUpgraded', (event) => {
  const newPlan = event.detail.plan;
  console.log(`Plan upgraded to: ${newPlan}`);
  
  // Refresh access control
  window.location.reload();
});

// Listen for usage updates
window.addEventListener('usageUpdated', (event) => {
  window.HalaxaAccessControl.updateUsageDisplay();
});

// Export for manual integration
window.AccessControlIntegration = {
  setupPaymentFormAccessControl,
  setupNetworkSelection,
  setupProtectedNavigation,
  initializePageAccessControl,
  setupUsageMonitoring,
  renderNetworkOptions,
  showRestrictionModal,
  showPageBanner
};

console.log('🔧 Access Control Integration Guide loaded'); 