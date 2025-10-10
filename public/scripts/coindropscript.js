function openGooglePlayStore() {
  window.open("https://play.google.com/store/apps/details?id=com.gspteck.coindrop", "_blank"); 
}

//  Random Session ID
let sessionID = '';
const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const charactersLength = characters.length;
for (let i = 0; i < 16; i++) {
  sessionID += characters.charAt(Math.floor(Math.random() * charactersLength));
}

// Data object to store collected information
const trackingData = {
  ipAddress: null,
  cookies: document.cookie,
  timeSpent: 0,
  scrollEvents: [],
  clickEvents: [],
  geolocation: null,
  deviceModel: 'unknown',
  operatingSystem: 'unknown',
  browserType: 'unknown',
  buttonPresses: [],
	adNetwork: null,
};

// Track page load time
const startTime = performance.now();

// IP Address (using ipapi.co)
async function getIPAddress() {
  try {
    const response = await fetch('https://ipapi.co/json/');
    const data = await response.json();
    trackingData.ipAddress = data.ip;
  } catch (error) {
    console.error('Error fetching IP:', error);
    trackingData.ipAddress = 'unknown';
  }
}

// Time Spent on Page
function updateTimeSpent() {
  trackingData.timeSpent = ((performance.now() - startTime) / 1000).toFixed(2); // Time in seconds
}

// Scroll Patterns
window.addEventListener('scroll', () => {
  trackingData.scrollEvents.push({
    x: window.scrollX,
    y: window.scrollY,
    timestamp: Date.now()
  });
});

// Click Patterns
document.addEventListener('click', (event) => {
  trackingData.clickEvents.push({
    x: event.clientX,
    y: event.clientY,
    timestamp: Date.now()
  });
});

// Geolocation
function getGeolocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        trackingData.geolocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          timestamp: Date.now()
        };
      },
      (error) => {
        console.error('Geolocation error:', error);
        trackingData.geolocation = { error: error.message };
      }
    );
  } else {
    trackingData.geolocation = { error: 'Geolocation not supported' };
  }
}

// Device, OS, Browser (basic parsing of navigator.userAgent)
function getDeviceInfo() {
  const ua = navigator.userAgent;
  const trackingData = {};

  // Device Model (basic detection from userAgent)
  trackingData.deviceModel = ua.match(/(iPhone|iPad|Android|Mobile)/i)?.[0] || 'unknown';

  // Operating System (using userAgent and userAgentData if available)
  if (navigator.userAgentData) {
    // Modern browsers with userAgentData
    const platform = navigator.userAgentData.platform || 'unknown';
    trackingData.operatingSystem = platform;
  } else {
    // Fallback to userAgent parsing
    if (/Windows/i.test(ua)) trackingData.operatingSystem = 'Windows';
    else if (/Mac OS/i.test(ua)) trackingData.operatingSystem = 'MacOS';
    else if (/Linux/i.test(ua)) trackingData.operatingSystem = 'Linux';
    else if (/iPhone|iPad/i.test(ua)) trackingData.operatingSystem = 'iOS';
    else if (/Android/i.test(ua)) trackingData.operatingSystem = 'Android';
    else trackingData.operatingSystem = 'unknown';
  }

  // Browser Type
  if (/Chrome/i.test(ua) && !/Edg/i.test(ua)) trackingData.browserType = 'Chrome';
  else if (/Firefox/i.test(ua)) trackingData.browserType = 'Firefox';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) trackingData.browserType = 'Safari';
  else if (/Edg/i.test(ua)) trackingData.browserType = 'Edge';
  else trackingData.browserType = 'unknown';

  return trackingData;
}

// Button Presses
document.querySelectorAll('button').forEach((button, index) => {
  button.addEventListener('click', () => {
    trackingData.buttonPresses.push({
      buttonId: button.id || `button-${index}`,
      text: button.textContent.trim(),
      timestamp: Date.now()
    });
  });
});

//  Get Ad Network
const urlParams = new URLSearchParams(window.location.search);
trackingData["adNetwork"] = urlParams.get('utm_source');

// Before Window Closes Send Data To API
setTimeout(() => {
	setInterval(() => {
		updateTimeSpent();
		fetch("https://datadb-api.onrender.com/api", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": "7b892c5e364ae34bd42b333b268fee5a52f3faa6afe91f6afa5e19d836761002",
			},
			body: JSON.stringify({
				"app": "coindrop",
				"type": "landing_page",
				"data": {
					"sessionID": sessionID,
					trackingData,
				}
			}),
		});
	}, 1000);
}, 3000);

// Initialize
(async () => {
  await getIPAddress();
  getGeolocation();
  getDeviceInfo();
});
