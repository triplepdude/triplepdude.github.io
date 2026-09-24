---
layout: page
title: Privacy Policy
description: How TripleP Tools handles your data. The tools run entirely in your browser, so text, files, and device input never leave your device.
permalink: /privacy/
---
{%- assign ea = site.ads.ethicalads_publisher | default: "" | strip -%}
{%- assign adsense = site.ads.adsense_client | default: "" | strip -%}

## The short version

Every tool on this site runs entirely in your web browser. Text you type or
paste, files you open, and input from your camera, microphone, or keyboard are
processed on your own device. None of it is uploaded to a server, and this site
has no accounts, no sign-up, and no database.

## What the tools do with your data

- **Text and files** are read by JavaScript in your browser and never sent
  anywhere. Downloads are created on your device.
- **Camera, microphone, and location** are only requested when you press a
  button that needs them. Your browser asks for permission first, the stream is
  used only on the page, and it stops when you press Stop or leave the page.
- **Settings** you change may be remembered in your browser's local storage so
  they persist between visits. You can clear them at any time by clearing this
  site's data in your browser.

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
{%- elsif adsense != "" -%}
This site shows ads served by Google AdSense to keep the tools free.

- Third-party vendors, including Google, use cookies to serve ads based on your
  prior visits to this website or other websites.
- Google's use of advertising cookies enables it and its partners to serve ads
  to you based on your visit to this site and/or other sites on the Internet.
- You may opt out of personalized advertising by visiting
  [Google Ads Settings](https://adssettings.google.com/). You can also opt out
  of some third-party vendors' use of cookies for personalized advertising at
  [aboutads.info](https://www.aboutads.info/choices/).
- Learn more in [How Google uses information from sites or apps that use its
  services](https://policies.google.com/technologies/partner-sites).

Visitors in the European Economic Area, the United Kingdom, and Switzerland are
asked for consent before personalized ads are shown, and can change their
choice at any time from the privacy link in the consent message.
{%- else -%}
This site does not currently show ads. If advertising is added in the future,
this section will describe it before any ads appear.
{%- endif %}

Ads never block a tool, and every tool works the same with an ad blocker.

## Children

The site is a general-audience collection of utilities and is not directed at
children under 13.

## Changes and contact

Changes to this policy are published on this page, and its full history is
public in the site's
[GitHub repository](https://github.com/{{ site.github_username }}/{{ site.github_username }}.github.io/commits/main/privacy.md).
Questions can be raised by opening an
[issue on GitHub](https://github.com/{{ site.github_username }}/{{ site.github_username }}.github.io/issues).
