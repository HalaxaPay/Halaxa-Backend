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

// Countries with special pricing (ISO 2-letter country codes)
const SPECIAL_PRICING_COUNTRIES = [
  'IN', // India
  'NG', // Nigeria
  'VN', // Vietnam
  'ID', // Indonesia
  'BR', // Brazil
  'AR'  // Argentina
];

// Country names for logging
const COUNTRY_NAMES = {
  'SY': 'Syria',
  'KP': 'North Korea', 
  'CU': 'Cuba',
  'IR': 'Iran',
  'UA': 'Ukraine',
  'RU': 'Russia',
  'IN': 'India',
  'NG': 'Nigeria',
  'VN': 'Vietnam',
  'ID': 'Indonesia',
  'BR': 'Brazil',
  'AR': 'Argentina'
};

// Pricing configurations
const PRICING_CONFIGS = {
  // Special pricing for developing countries
  special: {
    pro: {
      monthly: 12,
      yearly: 9
    },
    elite: {
      monthly: 29,
      yearly: 19
    }
  },
  // Default pricing for rest of world
  default: {
    pro: {
      monthly: 29,
      yearly: 20
    },
    elite: {
      monthly: 59,
      yearly: 49
    }
  }
};

/**
 * Get pricing based on country code
 */
export function getPricingForCountry(countryCode) {
  try {
    if (!countryCode) {
      console.log('🌍 No country code provided, using default pricing');
      return PRICING_CONFIGS.default;
    }

    if (SPECIAL_PRICING_COUNTRIES.includes(countryCode.toUpperCase())) {
      const countryName = COUNTRY_NAMES[countryCode.toUpperCase()] || countryCode;
      console.log(`💰 Special pricing applied for ${countryName} (${countryCode})`);
      return PRICING_CONFIGS.special;
    }

    const countryName = COUNTRY_NAMES[countryCode.toUpperCase()] || countryCode;
    console.log(`💰 Default pricing applied for ${countryName} (${countryCode})`);
    return PRICING_CONFIGS.default;
  } catch (error) {
    console.error('❌ Error determining pricing for country:', error);
    return PRICING_CONFIGS.default;
  }
}

/**
 * Get pricing based on IP address
 */
export function getPricingForIP(ipAddress) {
  try {
    if (!ipAddress || ipAddress === '127.0.0.1' || ipAddress === 'localhost' || ipAddress.startsWith('192.168.') || ipAddress.startsWith('10.')) {
      console.log('🏠 Localhost detected - using default pricing');
      return PRICING_CONFIGS.default;
    }

    const geo = geoip.lookup(ipAddress);
    if (!geo) {
      console.log(`🔍 Could not determine location for IP: ${ipAddress} - using default pricing`);
      return PRICING_CONFIGS.default;
    }

    return getPricingForCountry(geo.country);
  } catch (error) {
    console.error('❌ Error determining pricing for IP:', error);
    return PRICING_CONFIGS.default;
  }
}

/**
 * Get client IP address from request
 */
export function getClientIP(req) {
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
 * Get pricing middleware that adds country-based pricing to request
 */
export const geoPricingMiddleware = (req, res, next) => {
  try {
    const clientIP = getClientIP(req);
    const pricing = getPricingForIP(clientIP);
    
    // Add pricing and geo info to request object
    req.geoPricing = pricing;
    req.geoInfo = {
      ip: clientIP,
      country: null
    };

    // Try to get country info
    if (clientIP && clientIP !== '127.0.0.1' && !clientIP.startsWith('192.168.') && !clientIP.startsWith('10.')) {
      const geo = geoip.lookup(clientIP);
      if (geo) {
        req.geoInfo.country = geo.country;
        req.geoInfo.countryName = COUNTRY_NAMES[geo.country] || geo.country;
      }
    }

    next();
  } catch (error) {
    console.error('❌ Error in geo-pricing middleware:', error);
    // Fallback to default pricing
    req.geoPricing = PRICING_CONFIGS.default;
    req.geoInfo = { ip: null, country: null };
    next();
  }
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

  // Get current pricing for client
  router.get('/pricing/current', (req, res) => {
    const clientIP = getClientIP(req);
    const pricing = getPricingForIP(clientIP);
    const geo = geoip.lookup(clientIP);
    
    res.json({
      pricing,
      geo: {
        ip: clientIP,
        country: geo?.country || null,
        countryName: geo ? (COUNTRY_NAMES[geo.country] || geo.country) : null,
        isSpecialPricing: geo ? SPECIAL_PRICING_COUNTRIES.includes(geo.country) : false
      }
    });
  });

  // Test pricing for specific country or IP
  router.post('/pricing/test', (req, res) => {
    const { country, testIP } = req.body;
    
    let pricing, geoInfo;
    
    if (country) {
      pricing = getPricingForCountry(country);
      geoInfo = {
        country: country.toUpperCase(),
        countryName: COUNTRY_NAMES[country.toUpperCase()] || country,
        isSpecialPricing: SPECIAL_PRICING_COUNTRIES.includes(country.toUpperCase())
      };
    } else if (testIP) {
      pricing = getPricingForIP(testIP);
      const geo = geoip.lookup(testIP);
      geoInfo = {
        ip: testIP,
        country: geo?.country || null,
        countryName: geo ? (COUNTRY_NAMES[geo.country] || geo.country) : null,
        isSpecialPricing: geo ? SPECIAL_PRICING_COUNTRIES.includes(geo.country) : false
      };
    } else {
      return res.status(400).json({ error: 'Either country or testIP required' });
    }
    
    res.json({
      pricing,
      geo: geoInfo
    });
  });
};

export default geoBlockMiddleware; 