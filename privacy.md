---
layout: page
title: Privacy Policy
description: How TripleP Tools handles your data. The tools run in your browser, and this site uploads, stores and tracks nothing you enter; the few exceptions are listed.
permalink: /privacy/
last_modified_at: 2026-11-22
---
{%- assign ea = site.ads.ethicalads_publisher | default: "" | strip -%}
{%- assign adsense = site.ads.adsense_client | default: "" | strip -%}

## The short version

Every tool on this site runs in your web browser. Text you type or paste,
files you open, and input from your camera, microphone, or keyboard are
processed on your own device. This site uploads none of it, and it has no
accounts, no sign-up, and no database. A few features that you choose hand
something to your browser or to another site; they are listed below.

## What the tools do with your data

- **Text and files** are read by JavaScript in your browser and never sent
  anywhere by this site. Downloads are created on your device.
- **Online voices in Text to Speech.** Text to Speech reads aloud with the
  voices your browser offers. A voice marked Online (Google's voices in
  Chrome, the "Online (Natural)" voices in Edge) runs on Google's or
  Microsoft's servers, so your browser sends them the text it reads. The page
  says so whenever such a voice is chosen; the other voices run on your
  device.
- **Images from the web in Markdown to PDF** are fetched only if you tick
  Load images from the web, which tells the site hosting each image that the
  document was opened.
- **Use my location** in the MGRS Converter asks your browser for your
  position. Unless your device has a GPS fix, your browser or operating
  system usually works it out with a location service run by Google, Apple
  or Microsoft, from the Wi-Fi networks and mobile masts around you.
- **Camera, microphone, location, clipboard and notifications** are only
  requested when you press a button or tick a box that needs them, such as
  Start camera, Paste image or Show a notification when a timer ends. Your
  browser asks for permission first, a camera or microphone stream is used
  only on the page, and it stops when you press Stop or leave the page.
- **Nothing is saved in your browser's storage.** The tools use no cookies,
  local storage, or any other browser storage. Some tools, such as Wheel
  Spinner, GPA Calculator, Online Timer, Stopwatch and Date Calculator, keep
  their settings and entries in the page address after the # sign, so that a
  reload, a bookmark or a link brings them back. Browsers never send that part
  of the address to the server, but like any address it stays in your browser
  history until you clear it, and anyone you send the link to sees what it
  holds.

This site does not use its own cookies or analytics.

## Hosting

The site is hosted on GitHub Pages. When you visit, GitHub receives your IP
address and standard request information, as any web server does, and may log
it for security purposes. See the
[GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

## Advertising

{% if ea != "" -%}
This site is supported by [EthicalAds](https://www.ethicalads.io/), an ad
network that targets ads by page content, not by tracking you. EthicalAds does
not use tracking cookies or build a profile of you. See the
[EthicalAds privacy policy](https://www.ethicalads.io/privacy-policy/).

Ads never block a tool, and every tool works the same with an ad blocker.
{%- elsif adsense != "" -%}
This site shows ads served by Google AdSense to keep the tools free.

- Third-party vendors, including Google, use cookies to serve ads based on your
  prior visits to this website or other websites.
- Google's use of advertising cookies enables it and its partners to serve ads
  to you based on your visit to this site and/or other sites on the Internet.
- You may opt out of personalized advertising by visiting
  [Google Ads Settings](https://adssettings.google.com/). You can also opt out
  of some third-party vendors' use of cookies for personalized advertising at
  [aboutads.info](https://optout.aboutads.info/).
- Learn more in [How Google uses information from sites or apps that use its
  services](https://policies.google.com/technologies/partner-sites).

Visitors in the European Economic Area, the United Kingdom, and Switzerland are
asked for consent before personalized ads are shown, and can change their
choice at any time from the privacy link in the consent message.

Ads never block a tool, and every tool works the same with an ad blocker.
{%- else -%}
This site does not currently show ads. If advertising is added in the future,
this section will describe it before any ads appear.
{%- endif %}

## Children

The site is a general-audience collection of utilities and is not directed at
children under 13.

## Changes and contact

Changes to this policy are published on this page, and its full history is
public in the site's
[GitHub repository](https://github.com/{{ site.github_username }}/{{ site.github_username }}.github.io/commits/main/privacy.md).
Questions can be raised by opening an
[issue on GitHub](https://github.com/{{ site.github_username }}/{{ site.github_username }}.github.io/issues).
