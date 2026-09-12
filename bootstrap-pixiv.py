#!/usr/bin/env python3
"""One-time helper: get a Pixiv OAuth refresh token for PIXIV_REFRESH_TOKEN.

Usage:
    python bootstrap-pixiv.py login          # new token (opens browser)
    python bootstrap-pixiv.py refresh OLD    # re-mint from an old one

Requires: pip install requests
"""
import argparse
import base64
import hashlib
import random
import string
import sys
import urllib.parse
import webbrowser
from pprint import pprint

import requests

CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
CLIENT_SECRET = "lsACyCD94FhDUtGTt3rICEnzx6RuOa"
REDIRECT_URI = "https://app-api.pixiv.net/web/v1/users/auth/pixiv/callback"
LOGIN_URL = "https://app-api.pixiv.net/web/v1/login"
AUTH_TOKEN_URL = "https://oauth.secure.pixiv.net/auth/token"
USER_AGENT = "PixivAndroidApp/5.0.234 (Android 11; Pixel 5)"


def oauth_pkce():
    code_verifier = "".join(random.SystemRandom().choice(string.ascii_letters + string.digits) for _ in range(64))
    digest = hashlib.sha256(code_verifier.encode()).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return code_verifier, code_challenge


def print_tokens(data):
    access_token = data.get("access_token")
    refresh_token = data.get("refresh_token")
    if not access_token or not refresh_token:
        print("error:")
        pprint(data)
        sys.exit(1)
    print("\nPut this in .env:\n")
    print(f"PIXIV_REFRESH_TOKEN={refresh_token}")
    print(f"\n(access_token expires in {data.get('expires_in', '?')}s; the bot rotates it automatically)")


def login(_ns=None):
    code_verifier, code_challenge = oauth_pkce()
    login_url = f"{LOGIN_URL}?{urllib.parse.urlencode({
        'code_challenge': code_challenge,
        'code_challenge_method': 'S256',
        'client': 'pixiv-android',
    })}"
    webbrowser.open(login_url)
    print("Opened the Pixiv login page in your browser.")
    print("Log in and authorize. After authorizing you'll land on a blank page;")
    print("paste the full callback URL from the address bar below (or just its code):")
    raw = input("Callback URL or code: ").strip()

    parsed = urllib.parse.urlparse(raw)
    code = (
        urllib.parse.parse_qs(parsed.fragment).get("code")
        or urllib.parse.parse_qs(parsed.query).get("code")
    )
    code = (code and code[0]) or raw

    resp = requests.post(
        AUTH_TOKEN_URL,
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "code": code,
            "code_verifier": code_verifier,
            "grant_type": "authorization_code",
            "include_policy": "true",
            "redirect_uri": REDIRECT_URI,
        },
        headers={"User-Agent": USER_AGENT},
    )
    print_tokens(resp.json())


def refresh(old_refresh_token):
    resp = requests.post(
        AUTH_TOKEN_URL,
        data={
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
            "grant_type": "refresh_token",
            "include_policy": "true",
            "refresh_token": old_refresh_token,
        },
        headers={"User-Agent": USER_AGENT},
    )
    print_tokens(resp.json())


def main():
    parser = argparse.ArgumentParser(description="Fetch a Pixiv OAuth refresh token.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login").set_defaults(func=login)
    p = sub.add_parser("refresh", help="re-mint a refresh token from an existing one")
    p.add_argument("refresh_token")
    p.set_defaults(func=lambda ns: refresh(ns.refresh_token))
    ns = parser.parse_args()
    ns.func(ns)


if __name__ == "__main__":
    main()