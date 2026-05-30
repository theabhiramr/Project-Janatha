JANATA v2 — TEAM UPDATE & ASSIGNMENTS (May 29, 2026)

Everything below is plain text formatted for Slack. Select the "SLACK MESSAGE" block and paste straight into #product-updates (Slack will render *bold*, the code block, and the links).


====================================================================
SLACK MESSAGE — copy from here ↓
====================================================================

📣 @channel — Janata v2 is live on web for testing, and I could really use your help. 🙏

The app is in a great place. You can test it right now on web — prod (chinmayajanata.org) is untouched:
🔗 https://v2preview.project-janatha.pages.dev

Fastest way in: on the sign-in screen tap the small circle (bottom-left) → Developer Mode → pick a role (or "New user" for the full first-run flow). One tap switches roles.

Or log in manually — password for all: PreviewTest2026!
```
unverified@chinmayajanata.org   lvl 30   — the verified-only gates
member@chinmayajanata.org       lvl 45   — normal member (Boston)
sevak@chinmayajanata.org        lvl 54   — moderate + pin
brahmachari@chinmayajanata.org  lvl 108  — higher-tier member
admin@chinmayajanata.org        lvl 110  — full admin + moderation
```
The path from here: internal testing (now) → beta testing (Dallas + San Jose) → submit to the Apple App Store.

🐞 Found something off? Drop it in this channel — quote the flow line, no formal report needed.

📋 Testing checklist (tick a flow + add your initials): https://www.notion.so/36fca4196e3081e08156e24f9aa96183
✅ Formal UAT (one case per PRD criterion): https://www.notion.so/36fca4196e30819a84cfc28471f73b7f

— What I need from each of you 👇

🛠️ @Abhiram Ramachandran
• Keep chasing CCMT Apple Developer access. If it'll be slow, we decide: wait, or ship under my account — I'm fine either way. We can keep TestFlight on my personal account meanwhile, but I won't publish a new build until people approve.
• Keep building — grab or open PRs (we're on v2, merge without approval): https://github.com/Project-Janata/Janata/pulls
• With @Ananya Ramachandran: schedule Dallas beta testing (with Guha) — pick a window + get him set up.

👀 @Sahanav Ramesh @Satvik Suresh
• Review + test the v2 code yourselves: https://github.com/Project-Janata/Janata/tree/v2  (web now; TestFlight if folks approve).
• A few PRs need your review/input: https://github.com/Project-Janata/Janata/pulls

🌎 @Ananya Ramachandran @Abhiram Ramachandran
• Own Dallas beta testing: coordinate with Guha, set his access, plan the test window + what to test.

🌉 @Pranav Vaish
• Own San Jose beta testing with Siddharth (June SJ pilot) — onboarding + his first real events.
• Debrief Memorial Day camp (what happened, learnings, next steps).
• Darshan ji follow-up — recap the conversation + the Mukhya Swamiji escalation.

🎤 @Divita Gupta @Sanjna Suresh
• Test on web (use the checklist above): https://v2preview.project-janatha.pages.dev
• Pitch deck refresh + more marketing materials, and start lining up demos.

On me (Kish): App Store screenshots, demo recordings, contributing to the pitch deck, the Apple-account call, and onboarding Siddharth as a real SJ admin.

📊 Full picture / open decisions → Sprint Plan: https://www.notion.so/35aca4196e30800f9b30c7565a9da0a1

Thanks all — this is the stretch where Janata goes in front of real CHYKs. 🚀

====================================================================
SLACK MESSAGE — copy to here ↑
====================================================================


--------------------------------------------------------------------
ASSIGNMENTS AT A GLANCE
--------------------------------------------------------------------

Kish (me)        — App Store screenshots; demo recordings; contribute to pitch deck; Apple-account decision; onboard Siddharth as SJ admin
Abhiram          — CCMT Apple Developer access; keep building/merging on v2; review PRs
Ananya + Abhiram — Schedule + run Dallas beta testing (Guha)
Pranav           — Own San Jose beta testing (Siddharth); debrief Memorial Day camp; Darshan ji follow-up
Sahanav + Satvik — Review v2 code + test; review PRs needing input
Divita + Sanjna  — Web testing; pitch-deck refresh; marketing materials; demos

Links:
• Preview:  https://v2preview.project-janatha.pages.dev
• PRs:      https://github.com/Project-Janata/Janata/pulls
• v2 code:  https://github.com/Project-Janata/Janata/tree/v2
• Checklist: https://www.notion.so/36fca4196e3081e08156e24f9aa96183
• UAT:       https://www.notion.so/36fca4196e30819a84cfc28471f73b7f
• Sprint Plan: https://www.notion.so/35aca4196e30800f9b30c7565a9da0a1


--------------------------------------------------------------------
PITCH DECK — the ask
--------------------------------------------------------------------

Refresh the pitch deck before MSC outreach ramps. Kish contributes; Divita + Sanjna drive; everyone can suggest edits.

Changes to fold in (Bhuvanesh's feedback):
• Fix typos
• Correct MSC dates → Jul 30 – Aug 4, 2026
• Drop attendance tracking
• Add an Android slide
• Add MSC contact info
• Split the narrative: attendee story vs. organizer story

Target: a clean v2 deck for CHYK leaders + the Aug 1 demo.


--------------------------------------------------------------------
EXTERNAL BETA — Guha (Dallas) & Siddharth (San Jose)
--------------------------------------------------------------------

Keep these OUT of the dev @channel — they're pilot users, not contributors. Send each a short, non-technical DM.

DM template (tweak name/city) — copy from here ↓

Hey [Siddharth / Guha] — Janata v2 is ready to try on web (no install): https://v2preview.project-janatha.pages.dev
Log in with member@chinmayajanata.org / PreviewTest2026! to look around as a normal member.
Could you try 3 things and tell me what feels off?
1. Browse Explore → open an event → RSVP
2. Open your center page → read the board
3. Run the "new user" first-run flow (bottom-left circle → Developer Mode → New user)
Reply with anything confusing or broken — even tiny stuff. 🙏

— copy to here ↑

Siddharth (SJ, June pilot) — owned by Pranav, admin onboarding by Kish:
• Give him a real Verified Admin account on his own email (not the shared admin@ test login) so he can create actual SJ events + post on the SJ center board.
• 15-min live call to walk through creating an event (proves "net-easier than WhatsApp + Forms").
• Ask him to name 3–5 SJ CHYKs to invite first (first real Verified users + invite-link test).

Guha (Dallas) — owned by Ananya + Abhiram:
• Send the DM above, set his access, pick a test window, collect feedback in a Dallas thread.

Decision for Kish: give Siddharth a real web admin account NOW (web is demo-ready) rather than wait for TestFlight, so the SJ pilot can start in June.


--------------------------------------------------------------------
HOW TO SEND
--------------------------------------------------------------------

• Post the SLACK MESSAGE block as one message in #product-updates — it's standalone (preview, dev-mode tip, logins, feedback channel all inline).
• Keep the per-person asks inline (bold + tag) so each person sees their job while skimming.
• Pin the message so testers can find the link + logins all week.
• Send the Guha/Siddharth DMs separately (not in the channel).
