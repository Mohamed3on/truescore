# TrueScore privacy policy

Effective 4 October 2026.

TrueScore is a browser extension that shows a score computed from an item's own ratings and reviews on the shopping, travel, film, book and sports sites it supports. This page lists everything it stores and everywhere it sends data.

## No accounts, no tracking

TrueScore has no accounts, analytics or ads. It doesn't sell data, share it for advertising, or use it for anything other than showing scores, summaries and answers on the page you're viewing. It is never used to judge creditworthiness.

## On your device

- Settings, the AI provider keys you add (Gemini, OpenAI, DeepSeek) and the TrueScore password live in the extension's synced storage. Chrome syncs them to your Google account if Chrome sync is on.
- Scores, and the reviews they were computed from, are cached in the extension's storage and in the storage of the site you're on, so a page you've seen loads instantly. Google Maps entries are deleted after 30 days.
- On Google Maps, the extension keeps the request tokens that Maps' own page uses to load reviews, so it can load a place's reviews the same way. They stay on your device.

## What leaves your device

**The site you're on.** To score an item, TrueScore loads its ratings and reviews from the site you're viewing, or from the review service that site itself uses (Bazaarvoice on dm.de, Stamped on BJJ Fanatics, IMDb's API for films on IMDb and Letterboxd). These requests carry the item's ID, as the site's own requests do.

**TrueScore's server (truescore.mohamed3on.com).** On Google Maps, when you open a place, the extension sends the place's Google ID, name and page address to get its score, topic highlights and summary. When you summarize, search or ask a question, it also sends the place's public reviews and your search terms or question. Scores and summaries your browser computes are sent too, so the next person to open the place gets them sooner. On other sites, the reviews behind a search, summary or answer are sent so the server can read what each one says. On Reddit, nothing is sent until you open a thread's tally; then the extension sends the thread's title and text and the comments the page loaded, with each one's score, author's username and the comment it replies to. Every request carries the TrueScore password from the popup.

The server stores data per place: scores, reviews, summaries, highlights, and answers to questions asked about it, which it replays for a day to anyone who asks the same question. For a Reddit thread it keeps the options it found and what each comment says of them, not the comments. None of it records who sent it. To write summaries and answers, the server sends the place's reviews and the question to an AI provider, and to list a thread's options, the thread: OpenAI, or Google Gemini or DeepSeek if you pick one in the popup. To read what each review or comment says about a topic, question or option, it sends them to TypeSafe. Cloudflare, which sits in front of the server, sees your IP address like for any website; TrueScore itself doesn't log or store it.

**AI providers, only with your own key.** On product, book and film pages, summaries and questions go straight from your browser to the provider whose key you added (Google Gemini, OpenAI or DeepSeek), with the page's reviews and your question. That provider's privacy policy applies. Without a key, nothing is sent.

## Changes and contact

Changes to this policy are made in this file, so its history is public. Questions: [open an issue](https://github.com/Mohamed3on/truescore/issues).
