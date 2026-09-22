"""Best Fit seed for the fixed M1 search screen."""

# EVOLVE-BLOCK-START
def choose_bin(item, remaining_capacities):
    best_index = -1
    for index, remaining in enumerate(remaining_capacities):
        if remaining >= item and (
            best_index == -1 or remaining < remaining_capacities[best_index]
        ):
            best_index = index
    return best_index
# EVOLVE-BLOCK-END
