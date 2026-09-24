"""Service token for the router API (accounts/permissions since 2026-09-24): every /api/* call needs a login session
or `Authorization: Bearer <token>`. The router writes the token next to router.db (data/service_token, 0600) on first
start; ROUTER_SERVICE_TOKEN overrides it."""
import os, urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))


def token():
    t = os.environ.get("ROUTER_SERVICE_TOKEN")
    if t:
        return t.strip()
    path = os.environ.get("ROUTER_SERVICE_TOKEN_FILE", os.path.join(_HERE, "..", "data", "service_token"))
    try:
        return open(path).read().strip()
    except OSError:
        return ""


def request(url):
    """urllib Request with the bearer header (open it with urllib.request.urlopen)."""
    r = urllib.request.Request(url)
    t = token()
    if t:
        r.add_header("Authorization", "Bearer " + t)
    return r
