def format_name(first, last):
    """Return formatted full name."""
    return f"{first} {last}"


def validate_email(email):
    """Check if email looks valid."""
    if "@" in email and "." in email:
        return True
    return False


def retry_on_error(func, max_retries=3):
    """Retry a function on exception."""
    for attempt in range(max_retries):
        try:
            return func()
        except Exception as e:
            print(f"Attempt {attempt + 1} failed: {e}")
            if attempt == max_retries - 1:
                raise
    return None
