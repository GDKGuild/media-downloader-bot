"""Bootstrap a pixiv OAuth refresh token for media-downloader-bot.

No pixivpy dependency — plain requests + the official web-login OAuth flow
used by the pixiv Android client.

Usage:
    python bootstrap-pixiv.py            # full authorize + code exchange
    python bootstrap-pixiv.py --refresh  # rotate an existing refresh token
"""
import base64
import hashlib
import json
import re
import secrets
import sys
import webbrowser
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import urlopen

import requests

CLIENT_ID = "MOBrBDS8blbauoSck0ZfDbtuzpyT"
CLIENT_SECRET = "lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj"
LOGIN_URL = "https://app-api.pixiv.net/web/v1/login"
TOKEN_URL = "https://app-api.pixiv.net/web/v1/token"
OAUTH_URL = "https://oauth.secure.pixiv.net/auth/token"
CALLBACK_PATH = "/web/v1/users/auth/pixiv/callback"
REDIRECT_URI = f"https://app-api.pixiv.net{CALLBACK_PATH}"
UA = "PixivIOSApp/7.16.8 (iOS 16.4.1; iPhone14,3)"


def s256_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def load_env(root: Path) -> dict[str, str]:
    env_path = root / ".env"
    values: dict[str, str] = {}
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def write_env(root: Path, key: str, value: str) -> None:
    env_path = root / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    out = [line for line in lines if not line.lstrip().startswith(f"{key}=") and not line.lstrip().startswith(f"{key} =")]
    out.append(f"{key}={value}")
    env_path.write_text("\n".join(out) + "\n", encoding="utf-8")
    print(f"\nWrote {key} to {env_path}")


def get_public_ip() -> str:
    # pixiv needs a recognizable IP for the /web/v1/token exchange context.
    try:
        return json.load(urlopen("https://api.ipify.org/?format=json", timeout=10))["ip"]
    except Exception:
        return "127.0.0.1"


def get_code() -> str:
    print(f"Opening browser to {LOGIN_URL} ...")
    webbrowser.open_new(LOGIN_URL)
    print("\nLog in with your pixiv account.")
    print("After login you will land on a page whose address looks like:")
    print(f"  https://app-api.pixiv.net{CALLBACK_PATH}?state=...&code=...")
    print(
        "IMPORTANT: pixiv:// account deep-link codes CANNOT be redeemed by this "
        "client. If you get an 'invalid_grant'/'client credentials are invalid' "
        "error, the code you pasted is wrong. Copy the FULL address from the "
        "auth callback (the blank page right after login, or the network-tab "
        "request to app-api.pixiv.net" + CALLBACK_PATH + ")."
    )
    while True:
        raw = input("\nPaste the full callback URL (or just the code= value): ").strip()
        if not raw:
            continue
        code = raw
        if raw.startswith("http"):
            parsed = parse_qs(urlparse(raw).query)
            code = (parsed.get("code") or [""])[0]
        if re.fullmatch(r"[A-Za-z0-9_-]+", code):
            return code
        print("That does not look like a valid pixiv auth code. Try again.")


def exchange_code(code: str, verifier: str) -> dict:
    form = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "code": code,
        "code_verifier": verifier,
        "grant_type": "authorization_code",
        "include_policy": "true",
        "redirect_uri": REDIRECT_URI,
    }
    headers = {"User-Agent": UA, "Accept": "application/json"}
    resp = requests.post(TOKEN_URL, data=form, headers=headers, timeout=30)
    if resp.status_code >= 400:
        msg = "unknown"
        try:
            body = resp.json()
            msg = body.get("error_description") or body.get("error") or "unknown"
        except requests.JSONDecodeError:
            pass
        raise RuntimeError(f"Token exchange failed (HTTP {resp.status_code}): {msg}")
    return resp.json()


def exchange_refresh(refresh_token: str) -> dict:
    form = {
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }
    headers = {"User-Agent": UA, "Accept": "application/json"}
    resp = requests.post(OAUTH_URL, data=form, headers=headers, timeout=30)
    body = resp.json()
    if body.get("has_error") or not body.get("refresh_token"):
        raise RuntimeError(f"Refresh failed: {body.get('error') or body.get('message') or 'unknown'}")
    return body


def main() -> int:
    args = sys.argv[1:]
    root = Path.cwd()
    env = load_env(root)

    if "--refresh" in args:
        token = env.get("PIXIV_REFRESH_TOKEN")
        if not token:
            print("No PIXIV_REFRESH_TOKEN found in .env — run without --refresh first.")
            return 1
        print("Rotating existing refresh token...")
        data = exchange_refresh(token)
    else:
        ip = get_public_ip()
        print(f"Detected IP: {ip}")
        state = secrets.token_urlsafe(16)
        verifier = secrets.token_urlsafe(32)
        challenge = s256_challenge(verifier)
        params = urlencode(
            {
                "code_challenge": challenge,
                "code_challenge_method": "S256",
                "client": "pixiv-android",
                "state": state,
            }
        )
        print(f"Login URL: {LOGIN_URL}?{params}")
        code = get_code()
        print("Exchanging code for tokens...")
        data = exchange_code(code, verifier)

    token = data.get("refresh_token")
    if not token:
        print("Response contained no refresh_token:", json.dumps(data, indent=2))
        return 1
    write_env(root, "PIXIV_REFRESH_TOKEN", token)
    print("Got refresh token (also printed below in case .env is elsewhere):")
    print(token)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except requests.RequestException as err:
        print(f"Network error: {err}")
        raise SystemExit(1) from err
    except RuntimeError as err:
        print(str(err) or "Operation failed")
        raise SystemExit(1) from err