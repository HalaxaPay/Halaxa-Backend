import geoip from 'geoip-lite';

// Countries to block (ISO 2-letter country codes)
const BLOCKED_COUNTRIES = [
  'SY', // Syria
  'KP', // North Korea
  'CU', // Cuba
  'IR', // Iran
  'UA', // Ukraine
  'RU'  // Russia
];

// Country names for logging
const COUNTRY_NAMES = {
  'SY': 'Syria',
  'KP': 'North Korea', 
  'CU': 'Cuba',
  'IR': 'Iran',
  'UA': 'Ukraine',
  'RU': 'Russia'
};

/**
 * Get client IP address from request
 */
function getClientIP(req) {
  // Check various headers for the real IP
  const xForwardedFor = req.headers['x-forwarded-for'];
  const xRealIP = req.headers['x-real-ip'];
  const cfConnectingIP = req.headers['cf-connecting-ip']; // Cloudflare
  
  let ip = req.ip || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           (req.connection.socket ? req.connection.socket.remoteAddress : null);

  // Use forwarded IP if available (for proxies/load balancers)
  if (xForwardedFor) {
    ip = xForwardedFor.split(',')[0].trim();
  } else if (xRealIP) {
    ip = xRealIP;
  } else if (cfConnectingIP) {
    ip = cfConnectingIP;
  }

  // Handle IPv6 localhost
  if (ip === '::1' || ip === '::ffff:127.0.0.1') {
    ip = '127.0.0.1';
  }

  // Remove IPv6 prefix if present
  if (ip && ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  return ip;
}

/**
 * Geo-blocking middleware
 */
export const geoBlockMiddleware = (req, res, next) => {
  try {
    const clientIP = getClientIP(req);
    
    // Skip geo-blocking for localhost/development
    if (!clientIP || clientIP === '127.0.0.1' || clientIP === 'localhost' || clientIP.startsWith('192.168.') || clientIP.startsWith('10.')) {
      console.log('🏠 Localhost detected - skipping geo-blocking');
      return next();
    }

    // Get geo information
    const geo = geoip.lookup(clientIP);
    
    if (!geo) {
      console.log(`🔍 Could not determine location for IP: ${clientIP} - allowing access`);
      return next();
    }

    const country = geo.country;
    const countryName = COUNTRY_NAMES[country] || country;
    
    console.log(`🌍 Request from: ${countryName} (${country}) - IP: ${clientIP}`);

    // Check if country is blocked
    if (BLOCKED_COUNTRIES.includes(country)) {
      console.log(`🚫 BLOCKED: Access denied for ${countryName} (${country}) - IP: ${clientIP}`);
      
      // Return a generic error message
      return res.status(403).json({
        error: 'Access Denied',
        message: 'Service not available in your region',
        code: 'GEO_BLOCKED'
      });
    }

    // Country is allowed
    console.log(`✅ ALLOWED: ${countryName} (${country}) - IP: ${clientIP}`);
    next();

  } catch (error) {
    console.error('❌ Error in geo-blocking middleware:', error);
    // In case of error, allow access (fail-open for availability)
    next();
  }
};

/**
 * Frontend geo-blocking (less secure, easily bypassed)
 */
export const getFrontendGeoBlock = () => {
  return `
<script>
// ⚠️ WARNING: This can be easily bypassed by disabling JavaScript
// Use server-side blocking for real security

const BLOCKED_COUNTRIES = ['SY', 'KP', 'CU', 'IR', 'UA', 'RU'];

async function checkGeoBlocking() {
  try {
    // Using ipapi.co for frontend geo detection
    const response = await fetch('https://ipapi.co/json/');
    const data = await response.json();
    
    if (BLOCKED_COUNTRIES.includes(data.country_code)) {
      document.body.innerHTML = \`
        <div style="
          display: flex; 
          justify-content: center; 
          align-items: center; 
          height: 100vh; 
          background: #1a1a1a; 
          color: white; 
          font-family: Arial, sans-serif;
          text-align: center;
        ">
          <div>
            <h1>🚫 Access Denied</h1>
            <p>Service not available in your region</p>
            <p style="color: #666;">Error Code: GEO_BLOCKED</p>
          </div>
        </div>
      \`;
      console.log('Access blocked for country:', data.country_name);
    }
  } catch (error) {
    console.log('Geo-blocking check failed:', error);
    // Fail silently to maintain functionality
  }
}

// Run check when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', checkGeoBlocking);
} else {
  checkGeoBlocking();
}
</script>
  `;
};

/**
 * Get admin endpoint to check geo-blocking status
 */
export const geoAdminRoutes = (router) => {
  // Check current geo-blocking status
  router.get('/admin/geo-status', (req, res) => {
    const clientIP = getClientIP(req);
    const geo = geoip.lookup(clientIP);
    
    res.json({
      clientIP,
      geo: geo || 'Unknown',
      blockedCountries: BLOCKED_COUNTRIES.map(code => ({
        code,
        name: COUNTRY_NAMES[code] || code
      })),
      isBlocked: geo ? BLOCKED_COUNTRIES.includes(geo.country) : false
    });
  });

  // Test geo-blocking with custom IP
  router.post('/admin/geo-test', (req, res) => {
    const { testIP } = req.body;
    
    if (!testIP) {
      return res.status(400).json({ error: 'testIP required' });
    }

    const geo = geoip.lookup(testIP);
    const isBlocked = geo ? BLOCKED_COUNTRIES.includes(geo.country) : false;
    
    res.json({
      testIP,
      geo: geo || 'Unknown',
      isBlocked,
      countryName: geo ? (COUNTRY_NAMES[geo.country] || geo.country) : 'Unknown'
    });
  });
};

export default geoBlockMiddleware; 