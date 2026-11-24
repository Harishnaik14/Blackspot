def classify_risk(curve_severity='gentle', accident_count=0, distance_m=None):
    score = 0
    score += {'gentle': 1, 'moderate': 2, 'sharp': 4}.get(curve_severity, 1)
    score += 4 if accident_count >= 10 else 3 if accident_count >= 5 else 2 if accident_count >= 2 else 0
    if distance_m is not None:
        score += 2 if distance_m < 100 else 1 if distance_m < 300 else 0
    if score >= 8:
        return 'Critical'
    if score >= 6:
        return 'High'
    if score >= 3:
        return 'Medium'
    return 'Low'
