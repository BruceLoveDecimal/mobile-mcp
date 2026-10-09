// The DreamFace app map behind `dreamface-app/sitemap` and `dreamface-app/open`: what an agent driving the app needs
// before it taps. Same fields as the web map (opencli-mcp adapters/dreamface/_sitemap.js) with routes replaced by
// screens.
//
// Written from a depth-first walk on a device with the mobile_* tools (see README.md here), so every entry is something
// that was seen. Visible texts are quoted as they appear so they can be used as getByText targets; element refs (@eN)
// are never recorded because they expire on every screen read. Update this file (and VERIFIED) when a walk finds a
// change.

/** When and how the map was last checked: '<date> on <device/image>, DreamFace <versionName> (<versionCode>), <account>, <language>'. */
export const VERIFIED = '2026-09-29 on the qa-pixel emulator (Android 15, google_apis x86_64 with ARM translation), DreamFace 6.34.1 (63401), guest account (not logged in, 0 credits, 5/5 free today), English';

/** The app's own Activities, as the foreground Activity reports them. */
const MAIN = 'com.dreamapp.dubhe/com.myhexin.reface.biz.MainActivity';
const WEB = 'com.dreamapp.dubhe/com.myhexin.reface.biz.webview.WebViewActivity';

/**
 * Screens, parent first.
 * - id: stable name, the `screen` argument of `open` and `sitemap`
 * - activity: foreground Activity (Android) as mobile_get_foreground_app / adb report it
 * - markers: visible texts that together mean "this screen is showing"; `open` waits for all of them. Empty when the
 *   screen cannot be read (see TRAPS profile-unreadable) — `open` then only taps its way there.
 * - parent: id of the screen it is reached from (null for the launch screen)
 * - via: how a person gets here from the parent (free text, for readers)
 * - open: how `open` gets here: { url } (deep link, from anywhere) and/or { taps: ['exact visible text', …] } from the parent
 * - sections / controls: what is on the screen, visible text quoted exactly, where each control leads
 * - submit: buttons that start a paid or free-quota job: label, when it enables, what it costs
 *
 * Most tool screens are H5 pages inside WebViewActivity; their texts are in the accessibility tree once loaded.
 *
 * @type {Array<{ id: string, activity?: string, markers: string[], parent: string | null, via: string, open?: { url?: string, taps?: string[] }, sections?: string[], controls?: string[], submit?: string[] }>}
 */
export const SCREENS = [
  {
    id: 'home',
    activity: MAIN,
    markers: ['Search for anything', 'Talk/Sing'],
    parent: null,
    via: 'launch screen: the Explore tab',
    sections: [
      'top bar: "EN" (language), "Search for anything", "PRO"',
      'three entry cards: "Avatar" "Talk/Sing", "Video" "Image to Vid", "Image" "Generate"',
      'tool grid: "AI Filter", "DreamAct" (tag "New"), "Enhance", "Magic Effect", "Pet Lip Sync", "Podcast", "BG Remover", "Voice Studio" (the indicator below suggests a second page; swiping did not turn it on the emulator)',
      'template feed, one carousel per section; titles and cards change with operations, e.g. "Weekly Fresh-AI Filter" (Image), "✨New Arrivals" (Video), "Trending-AI Filter", "Weekly Drop-DreamAct", "Daily New-Act", "Interaction-AI Filter", "Trend Act", "Romance Moment-AI Filter", "Magical Pets", "Daily life-AI Filter", "Fun Effects", "Pop Music", "Classic Rewind", "Character Morph"',
      'bottom tabs: "Explore", "Live", "Agent", "Profile"',
    ],
    controls: [
      'an AI Filter feed card (e.g. "Tropical Beach Vibe") → filter-template',
      'a Video feed card → its video template (not walked)',
    ],
  },
  {
    id: 'avatar',
    activity: WEB,
    markers: ['Want Avatar To Say Or Sing', 'Choose Voice'],
    parent: 'home',
    via: 'entry card "Avatar" "Talk/Sing"',
    open: { taps: ['Talk/Sing'] },
    sections: [
      'preview on top; avatar strip: "+" (upload a photo) then sample avatars (video icons)',
      'rows: "Want Avatar To Say Or Sing" >, "Choose Voice" >, "Animate Effect" > (shows the model: "Dream Avatar 1.0" or "Dream Avatar 3.0 Fast"), "Advance >"',
    ],
    controls: [
      '"Want Avatar To Say Or Sing" → avatar-script sheet',
      '"Choose Voice" → voice picker (not walked)',
      '"Animate Effect" → avatar model picker (not walked)',
    ],
    submit: ['"Animate": disabled until a script (and voice) is set; the cost is not shown before (not tapped)'],
  },
  {
    id: 'avatar-script',
    activity: WEB,
    markers: ['Text Script', 'Audio Script'],
    parent: 'avatar',
    via: 'row "Want Avatar To Say Or Sing": a sheet titled "Script"',
    open: { taps: ['Want Avatar To Say Or Sing'] },
    sections: ['"Text Script": "Type"', '"Audio Script": "Search music or any content", "Import", "Record"'],
  },
  {
    id: 'ai-video',
    activity: WEB,
    markers: ['Image to Video', 'Text to Video'],
    parent: 'home',
    via: 'entry card "Video" "Image to Vid" (the page is titled "AI Video")',
    open: { taps: ['Image to Vid'] },
    sections: [
      'header: back, credit icon "积分" with the credit count',
      'tabs: "Image to Video" (default), "References to Video", "Transition", "Text to Video", "Template"',
      'Image to Video: "Add image" (the rest appears once an image is added)',
      'References to Video: "Upload up to 9 references (images≤9/videos total time≤15s). Include people, objects, or scenes. Try a template"',
      'Transition: "Start Frame", "End Frame"',
      'Text to Video: "Describe your video..." (counter "0/2000"), model button "DreamVideo 1.5", resolution "480p", an idea bulb',
      'Template: grid of video templates, each with "N Uses" (e.g. "WARM LIBRARY", "GLIMMER PAWS")',
    ],
    controls: [
      'credit icon "积分" → credits',
      'Text to Video → model button "DreamVideo 1.5" → video-models sheet',
    ],
    submit: ['Text to Video "Create": enabled once there is a description; every model shows a coin (credits)'],
  },
  {
    id: 'video-models',
    activity: WEB,
    markers: ['Animate Effect', 'Seedance 2.0'],
    parent: 'ai-video',
    via: 'tab "Text to Video", then the model button (reads the selected model, "DreamVideo 1.5" by default): a sheet titled "Animate Effect". The tab row scrolls: "Text to Video" is off screen until the tabs before it are tapped. The model button does not always open the sheet (see TRAPS video-model-button); the path goes to "Template" and back, which made it open when walked by hand',
    open: { taps: ['References to Video', 'Transition', 'Text to Video', 'Template', 'Text to Video', 'DreamVideo 1.5'] },
    sections: [
      '"Dream Video 3.0" (tag "Beta") "Upgraded model. More power, same price."',
      '"DreamVideo 1.5" (default) "Enhanced character control and faster generation"',
      '"Seedance 2.5" (tag "NEW") "Powerful AI, 30s generation, and precise timeline control"',
      '"Seedance 2.0 Mini" "Quickly generate clear, smooth, and natural-looking video content."',
      '"Seedance 2.0" "The next-generation video creation model that turns ideas into finished video clips."',
      'each with a coin: it costs credits',
    ],
  },
  {
    id: 'credits',
    activity: WEB,
    markers: ['Purchase Credits', 'Total Credits'],
    parent: 'ai-video',
    via: 'the credit icon "积分" in the AI Video header (also Profile → the credit card, which cannot be read, see TRAPS)',
    open: { taps: ['积分'] },
    sections: [
      '"Purchase Credits" with "Get free" (→ get-free) and a close ×',
      'numbers above their labels: "Total Credits", "Purchased", "Weekly Credits"',
      '"History Of Credits >", "Get More Credits" (packs; placeholders on the emulator)',
    ],
    submit: ['"Pay": buys credits with real money — never'],
  },
  {
    id: 'image-generate',
    activity: WEB,
    markers: ['AI Image Generator', 'Create image from text or image'],
    parent: 'home',
    via: 'entry card "Image" "Generate"',
    open: { taps: ['Generate'] },
    sections: ['"AI Image Generator" "Create image from text or image", a sample carousel', 'bottom bar "Describe the image you expect..." (not in the accessibility tree: tap the bar near the bottom)'],
    controls: ['the bottom bar → image-composer'],
  },
  {
    id: 'image-composer',
    activity: WEB,
    markers: ['Inspire me', 'Dream Image 2.0'],
    parent: 'image-generate',
    via: 'tap the "Describe the image you expect..." bar at the bottom (it has no accessibility text, so open cannot tap it; screen.tap at about 50% width, 93% height)',
    sections: [
      '"Reference" (reference image), the prompt field, "Inspire me", ratio "4 : 3"',
      'models, one row scrolling sideways: "Dream Image 2.0" (default), "GPT Image 2.5 Sunburst" (tag "New"), "GPT Image 2.5 Flare" (tag "New"), "Seedream 5.0 Pro", "Nano Banana 2", "Seedream 4.5"',
    ],
    submit: ['"Create": enabled once the prompt has text; no cost shown on the button (Dream Image 2.0 is free on the web)'],
  },
  {
    id: 'ai-filters',
    markers: ['AI Filters', 'Weekly Fresh'],
    parent: 'home',
    via: 'tool "AI Filter"',
    open: { taps: ['AI Filter'] },
    sections: ['"AI Filters": template carousels by section ("Weekly Fresh", "80s", "Wallpaper", …)'],
    controls: ['a template card → filter-template'],
  },
  {
    id: 'filter-template',
    activity: 'com.dreamapp.dubhe/com.myhexin.reface.biz.aigc.AiPaintPreviewActivity',
    markers: ['Animate'],
    parent: 'ai-filters',
    via: 'a template card (content changes, so open has no taps); also from the home feed',
    sections: [
      'first visit: a guide "Upload your photos", "Good photos examples", "Bad examples", "I Know !" (then the Photos permission, see TRAPS)',
      'preview on top with a heart and "…"; picker sheet: "All" (album), "Portraits" switch, "Camera", sample face photos, "Get album permissions >"',
    ],
    submit: ['"Animate": looks enabled before a photo is picked; cost not shown (not tapped)'],
  },
  {
    id: 'dreamact',
    activity: WEB,
    markers: ['Customize Avatar Acting'],
    parent: 'home',
    via: 'tool "DreamAct"',
    open: { taps: ['DreamAct'] },
    sections: [
      '"DreamAct" "Customize Avatar Acting" "Upload a reference video to make your avatar imitate the same motion." "Try Now"',
      '"Hot Template" tabs: "All", "New", "Hot Picks", "Dance & Sing", "Instrument", "Role Replace", "Sports", "Baby Dance", "Extreme Sports", "Pet Dance", "Classic", "Festival", "Body Groove", "Comedy", "Travel Snap"',
    ],
  },
  {
    id: 'enhance',
    activity: WEB,
    markers: ['One-click HQ image or video'],
    parent: 'home',
    via: 'tool "Enhance" (a blank white dialog shows for several seconds first)',
    open: { taps: ['Enhance'] },
    sections: ['"Enhance" "One-click HQ image or video"', '"Pick a photo" "High Quality"', '"Pick a video" "Within 60s" (tag "Free Trial")'],
  },
  {
    id: 'magic-effect',
    activity: WEB,
    markers: ['Magic Effect', 'Hot Picks'],
    parent: 'home',
    via: 'tool "Magic Effect"',
    open: { taps: ['Magic Effect'] },
    sections: [
      'header: "Magic Effect" and the credit count',
      'tabs: "All", "Hot Picks", "Interaction", "Magical Pets", "Effects", "Dance", "Photo Live", "Travel", "Product", "Character Morph", "Festival", "Scene Switch", "Hairstyle", "Animals", "Dream Football", "Pets"',
      'template grid with "N Uses"',
    ],
  },
  {
    id: 'pet-video',
    activity: WEB,
    markers: ['Customize Pet Video'],
    parent: 'home',
    via: 'tool "Pet Lip Sync" (the page is titled "Pet Video")',
    open: { taps: ['Pet Lip Sync'] },
    sections: ['"Talk & Sing Freely" "Customize Pet Video" "By any text, audio, songs" "Try Now"', '"Hot Templates 🔥" with song cards'],
  },
  {
    id: 'podcast',
    activity: WEB,
    markers: ['Avatar Podcast'],
    parent: 'home',
    via: 'tool "Podcast"',
    open: { taps: ['Podcast'] },
    sections: ['"Avatar Podcast" "Launch your own podcast show with AI"', '"Start to Create"'],
  },
  {
    id: 'bg-remover',
    activity: WEB,
    markers: [],
    parent: 'home',
    via: 'tool "BG Remover"',
    open: { taps: ['BG Remover'] },
    sections: ['"Remove Background" "Efficient image cutout tool" and "Pick a photo" (seen on screen; not in the accessibility tree when read, so no markers)'],
  },
  {
    id: 'voice-studio',
    activity: WEB,
    markers: ['High-quality AI Voice Tools'],
    parent: 'home',
    via: 'tool "Voice Studio"',
    open: { taps: ['Voice Studio'] },
    sections: ['"Voice Studio" "High-quality AI Voice Tools"', 'tools: "AI Cover Song", "Voice Translator", "Text To Audio", "Vocal Separation" (not walked)'],
  },
  {
    id: 'search',
    activity: WEB,
    markers: ['Hot', 'Cancel'],
    parent: 'home',
    via: 'top bar "Search for anything"',
    open: { taps: ['Search for anything'] },
    sections: ['search field and "Cancel"', '"Hot" tags: "Rock", "Birthday", "baby", "Dance", "Country", "Party", "R&B", "Wedding", "Rap", "Love", "Happy", …'],
  },
  {
    id: 'subscription',
    activity: 'com.dreamapp.dubhe/com.myhexin.reface.biz.billing.SubscriptionActivityV3',
    markers: [],
    parent: 'home',
    via: 'top bar "PRO" (also Profile "Upgrade to Pro >")',
    open: { taps: ['PRO'] },
    sections: ['plans and prices; on the emulator only a skeleton and a spinner (no Google Play billing)'],
    submit: ['plan / subscribe buttons: real money — never'],
  },
  {
    id: 'language',
    activity: MAIN,
    markers: ['Supported languages'],
    parent: 'home',
    via: 'top bar "EN" (the current language code)',
    open: { taps: ['EN'] },
    sections: ['"Language" with ×; "Current language" "English (EN)"', '"Supported languages": English (EN), Français (FR), Español (ES), 한국어 (KO), 日本語 (JA), Türkçe (TR), Português (PT), Русский язык (RU), Deutsch (DE), Italiano (IT), 简体中文（ZH）, (AR) اللغة العربية, हिन्दी (HI), Bahasa Indonesia (ID)'],
    controls: ['picking a language switches the whole app, and every marker here is English: do not'],
  },
  {
    id: 'live',
    activity: MAIN,
    markers: ['Following', 'Videos'],
    parent: 'home',
    via: 'bottom tab "Live"',
    open: { taps: ['Live'] },
    sections: [
      'top tabs "Following", "Live" (default), "Videos"',
      '"CREATE YOUR LIVE" "• Ready" "Your avatar is ready to go live" "Go Live"',
      '"EXPLORE LIVE ROOMS": "Featured", "Soul", "Pet", "TalkShow"; room cards "LIVE" with title, host and viewers',
    ],
  },
  {
    id: 'agent',
    activity: MAIN,
    markers: ['Try an idea'],
    parent: 'home',
    via: 'bottom tab "Agent"',
    open: { taps: ['Agent'] },
    sections: [
      'title "New Chat"; "Open conversation history" (left), "New Chat" (right)',
      '"Hi" "Creator" "Images, videos, or audio—I can create whatever you want."',
      '"Try an idea" + "Change": idea rows (content changes, e.g. "Video Recreation", "UGC advertisement", "Character Swap")',
      'composer "Describe what you expect..." with "+" (attach), the free uses left ("3 Free", id tv_free_points) and "Send message"',
    ],
    submit: ['"Send message": starts an agent run; uses a free agent use while "N Free" lasts, then credits'],
  },
  {
    id: 'profile',
    activity: MAIN,
    markers: [],
    parent: 'home',
    via: 'bottom tab "Profile" (its elements cannot be read, see TRAPS)',
    open: { taps: ['Profile'] },
    sections: [
      'top: "Get Free >" (→ get-free), icons: messages (→ inbox), scan, settings (→ settings)',
      'name (a guest gets one like "Efficient Day 5279"), "Home Page >" (→ homepage), "0 Followers" "0 Following", edit pencil',
      '"5 / 5 Free today" "Upgrade to Pro >" (→ subscription); credit card: count and "0 Weekly" (→ credits)',
      'tabs "Creations", "Avatars", "Voices", "Likes"; empty: "Nothing here yet"',
    ],
  },
  {
    id: 'get-free',
    activity: WEB,
    markers: ['Invite friends and earn free credits together'],
    parent: 'profile',
    via: '"Get Free >" on Profile (also "Get free" on credits)',
    sections: ['steps: "Referral creates a new account", "Finish the first work", "Your will get 1 Credits", "Referral will get 1 Credits"', '"Share to friends", "Copy Link"', '"My Rewards": "Friends Joined", "Credits Received"'],
  },
  {
    id: 'inbox',
    activity: 'com.dreamapp.dubhe/com.myhexin.reface.biz.inbox.InboxActivity',
    markers: ['Inbox'],
    parent: 'profile',
    via: 'the message icon on Profile',
    sections: ['"Inbox" "Feedback"', '"Turn on Notifications": "Turn On" / "Ignore"', '"Likes", "Comments", "New Followers"'],
  },
  {
    id: 'settings',
    activity: 'com.dreamapp.dubhe/com.myhexin.reface.biz.setting.SettingActivity',
    markers: ['Settings', 'Function Setting'],
    parent: 'profile',
    via: 'the gear icon on Profile',
    sections: [
      '"Account" row (id menuLogin): "Log in" while the app runs as a guest (→ login); signed in it shows the nickname (→ account)',
      '"Social": "Share DreamFace App", "Discord"',
      '"Function Setting": "Remove watermark", "Remove AI Watermark", "Clear cache" (size), "Apply Coupon", "Use third-party AI models" (On), "Privacy Permissions Settings"',
      '"Contact Us": "Email"',
    ],
    controls: ['all of these change settings or the account: read only'],
  },
  {
    id: 'account',
    activity: 'com.dreamapp.dubhe/com.myhexin.reface.biz.login.AccountActivity',
    markers: ['Account', 'Log out'],
    parent: 'settings',
    via: 'the Account row (nickname) in Settings while signed in',
    sections: [
      'the signed-in email on top, then "Headshot", "Nickname", "Biography"',
      '"Log out" (id menuLogout) asks "Log out your account?" with "Cancel" (tv_top) and "Log out" (tv_bottom)',
      '"Delete account"',
    ],
    controls: ['"Log out" and "Delete account" change the account: only dreamface-app/login uses them, and never "Delete account"'],
  },
  {
    id: 'login',
    activity: 'com.dreamapp.dubhe/com.myhexin.reface.biz.login.AccountLoginActivity',
    markers: ['Welcome to Dreamface', 'Continue with Email'],
    parent: 'settings',
    via: '"Log in" under Account in Settings (a guest only)',
    sections: ['"Welcome to Dreamface" "log in to continue"', '"Continue with Google", "Continue with Email" (→ login-email)', 'close ×'],
    controls: ['dreamface-app/login drives the email login; do not sign in by hand during a test'],
  },
  {
    id: 'login-email',
    activity: 'com.dreamapp.dubhe/com.myhexin.reface.biz.login.AccountBindActivity',
    markers: ['Your Email', 'Continue'],
    parent: 'login',
    via: '"Continue with Email"',
    sections: [
      'email field (et_email, hint "Your Email"), "Continue" (btn_continue); an email without an account goes on to sign-up',
      'then the password field (et_pwd) and the same button; "Incorrect password" on a wrong one',
      'a code step "Enter the code that was sent to …" for a new account or a check (entered by a person)',
      '"Forgot password?"',
    ],
    controls: ['"Continue" with an unknown email starts creating an account: only dreamface-app/login uses this screen'],
  },
  {
    id: 'homepage',
    activity: WEB,
    markers: ['No posts yet'],
    parent: 'profile',
    via: '"Home Page >" on Profile',
    sections: ['name, bio "An interesting soul cannot be described in words.", "0Followers" "0Following"', 'posts; empty: "No posts yet"'],
  },
];

/** Things that cost credits, lose state or mislead a driver, most expensive first. @type {Array<{ id: string, screens?: string[], symptom: string, fix: string }>} */
export const TRAPS = [
  {
    id: 'pay-buttons',
    screens: ['credits', 'subscription'],
    symptom: '"Pay" on Purchase Credits and the plan buttons on the subscription page charge real money.',
    fix: 'Never tap them. Read the numbers only.',
  },
  {
    id: 'sample-images',
    screens: ['filter-template', 'avatar'],
    symptom: 'Sample face photos in the filter picker and sample avatars in the avatar strip select themselves as input; "Animate" is then one tap from a generation.',
    fix: 'Do not tap samples while walking. A test that generates picks its input on purpose and runs at most once.',
  },
  {
    id: 'enter-submits',
    screens: ['image-composer'],
    symptom: 'The keyboard\'s Enter in a prompt field may submit the form like "Create".',
    fix: 'Type without a trailing Enter (mobile_type_keys submit=false); clear with Backspace.',
  },
  {
    id: 'agent-ideas',
    screens: ['agent'],
    symptom: '"Try an idea" rows fill (and may send) a prompt, which starts an agent run and uses a free agent use.',
    fix: 'Not tapped. Treat them like "Send message".',
  },
  {
    id: 'consent',
    symptom: 'The first H5 tool page (Avatar, Video, …) after install shows a "User Consent" sheet ("User Agreement and Privacy Policy") with "Agree to Continue" / "Back to Home"; open waits for markers behind it and times out.',
    fix: 'Consent is the user\'s call; once agreed (done on the qa-pixel emulator on 2026-09-29) it does not come back. "Back to Home" leaves.',
  },
  {
    id: 'back-closes-h5',
    symptom: 'The Android Back key on an H5 page (WebViewActivity) closes the whole page, not the sheet on top of it; the next tap lands on home.',
    fix: 'Close sheets by tapping outside them or their ×; use Back only to leave the page.',
  },
  {
    id: 'profile-unreadable',
    screens: ['profile'],
    symptom: 'The Profile tab cannot be read: every UI dump fails with "no XML content found in uiautomator dump" (its empty-state animation, seen with an empty account). Locators there time out.',
    fix: 'Read credits through the AI Video header (dreamface-app/credits) instead; reach Profile subpages with screen.tap by position if needed.',
  },
  {
    id: 'deep-links-open-the-website',
    symptom: 'https://dreamfaceapp.com/<path> (the only links the app declares, besides dreamface.onelink.me) opens the website page in an in-app browser (WebViewActivity with a title bar and ×), e.g. /avatar shows "AI Avatar Video Generator – … | DreamFace", not the app\'s Avatar screen.',
    fix: 'open navigates by taps from home; there is no deep link to app screens.',
  },
  {
    id: 'photos-permission',
    screens: ['filter-template'],
    symptom: '"I Know !" on the filter guide asks for the Photos permission; "Don\'t allow" shows "Access Permission Denied" with "Settings" / "Cancel".',
    fix: 'Cancel keeps the template page usable with the sample photos and the camera; do not change the permission in Settings.',
  },
  {
    id: 'video-model-button',
    screens: ['ai-video', 'video-models'],
    symptom: 'The model button ("DreamVideo 1.5") on the "Text to Video" tab opens the "Animate Effect" sheet only sometimes: dead on the first visit, working after a switch to "Template" and back, dead again after the sheet was closed. Its title "Animate Effect" also shows later than the rows, and a second tap lands on the first row and closes the sheet.',
    fix: 'Tap once, then wait for a row ("Seedance 2.0") rather than the title; if nothing opens, switch tabs and back. There is no video-models command because of this; read the models by hand.',
  },
  {
    id: 'subscription-spins',
    screens: ['subscription'],
    symptom: 'On an emulator image without Google Play the subscription page spins forever, and its × does not close it.',
    fix: 'The Back key leaves it.',
  },
  {
    id: 'live-network-error',
    screens: ['live'],
    symptom: 'The Live tab showed "Network Error" / "Retry" over the rooms on the emulator.',
    fix: 'Live rooms are not testable there; the tab itself still loads.',
  },
];

/** Which command covers which screen, and where the server-side check lives (the web adapter, same account). */
export const COMMANDS = [
  { command: 'dreamface-app/sitemap', screens: [], screen: '(none: reads this file)', note: 'read' },
  { command: 'dreamface-app/login', screens: ['settings', 'account', 'login', 'login-email'], screen: 'Settings → Log in → Continue with Email (signed in: Settings → Account → Log out first)', note: 'write: signs the app in to an email account (logs out another); a verification code is entered by a person' },
  { command: 'dreamface-app/open', screens: SCREENS.filter((s) => s.open).map((s) => s.id), screen: 'any screen with `open` taps', note: 'read: launches the app and navigates, never submits' },
  { command: 'dreamface-app/credits', screens: ['credits', 'agent'], screen: 'Purchase Credits (via the AI Video header) and the agent composer', note: 'read: total / purchased / weekly credits and free agent uses, as dreamface/credits reads them on the web' },
  { command: 'dreamface-app/image-models', screens: ['image-composer'], screen: 'AI Image Generator composer', note: 'read: the model row, as dreamface/image-models lists them on the web' },
  { command: 'dreamface/credits (web, opencli-mcp)', screens: ['credits'], screen: 'credit count', note: 'same account as the app: check credits before and after an app write' },
  { command: 'dreamface/works (web, opencli-mcp)', screens: ['profile'], screen: 'creations list', note: 'same account: confirm a generation started from the app reached the server' },
];

export const screenById = (id, screens = SCREENS) => screens.find((s) => s.id === id);

/** The screen and its descendants. */
export function subtree(id, screens = SCREENS) {
  const out = [];
  const walk = (sid) => {
    const s = screenById(sid, screens);
    if (!s) return;
    out.push(s);
    for (const child of screens.filter((c) => c.parent === sid)) walk(child.id);
  };
  walk(id);
  return out;
}

/** Draw the screen tree. */
export function tree(screens = SCREENS) {
  if (!screens.length) return '(no screens recorded yet)';
  const included = new Set(screens.map((s) => s.id));
  const children = new Map();
  for (const s of screens) {
    const parent = included.has(s.parent) ? s.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  const lines = [];
  const walk = (s, indent) => {
    const how = s.open?.url ? `  ⇢ ${s.open.url}` : '';
    const warn = (s.submit ?? []).length ? '  $ submits' : '';
    lines.push(`${indent}${s.id}${s.activity ? `  (${s.activity})` : ''}${how}${warn}`);
    for (const child of children.get(s.id) ?? []) walk(child, `${indent}  `);
  };
  for (const root of children.get(null) ?? []) walk(root, '');
  return lines.join('\n');
}
