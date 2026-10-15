"""Best Fit seed for the fixed M1 search screen."""

# EVOLVE-BLOCK-START
def choose_bin(item, remaining_capacities):
    # Size-aware target residual: leave more room for small items (peer),
    # prefer tight fit for large items.
    if item >= 60:
        target = 0.5 * item
    elif item >= 30:
        target = 0.8 * item
    elif item >= 15:
        target = 1.2 * item
    else:
        target = 1.5 * item

    near_perfect_index = -1
    near_perfect_residual = None
    # Tighter near-perfect threshold: small residuals (<= 10 or <= 0.2*item)
    # are strongly preferred because they close bins efficiently.
    near_perfect_limit = min(10, 0.2 * item) if item >= 10 else 0.5 * item

    best_index = -1
    best_score = None
    best_residual = None

    for index, remaining in enumerate(remaining_capacities):
        if remaining < item:
            continue
        residual = remaining - item
        if residual == 0:
            return index
        if residual <= near_perfect_limit:
            if near_perfect_index == -1 or residual < near_perfect_residual:
                near_perfect_index = index
                near_perfect_residual = residual
            continue
        # Score = absolute distance from size-aware target residual.
        score = residual - target
        if score < 0:
            score = -score
        if best_index == -1 or score < best_score or (
            score == best_score and residual < best_residual
        ):
            best_index = index
            best_score = score
            best_residual = residual

    if near_perfect_index != -1:
        return near_perfect_index
    return best_index
# EVOLVE-BLOCK-END