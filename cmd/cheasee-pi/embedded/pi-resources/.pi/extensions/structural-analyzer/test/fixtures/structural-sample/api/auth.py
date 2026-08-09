def verify_token(token):
    """Validate an authentication token."""
    if not token:
        raise ValueError("Token cannot be empty")
    return True


def login(username, password):
    """Authenticate a user."""
    try:
        user = find_user(username)
        if user.verify_password(password):
            token = generate_token(user)
            print(f"Login successful for {username}")
            return token
        else:
            print(f"Login failed for {username}")
            return None
    except Exception as e:
        print(f"Login error: {e}")
        return None


def find_user(username):
    """Find user by username (stub)."""
    return type("User", (), {"verify_password": lambda self, pwd: True})()


def generate_token(user):
    """Generate auth token (stub)."""
    return "token-abc123"
