package probe

import "math"

const earthRadiusKm = 6371.0

func HaversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	dLat := degToRad(lat2 - lat1)
	dLon := degToRad(lon2 - lon1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(degToRad(lat1))*math.Cos(degToRad(lat2))*
			math.Sin(dLon/2)*math.Sin(dLon/2)
	c := 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
	return earthRadiusKm * c
}

// BearingDeg returns the initial bearing in degrees (0–360) from point 1 to point 2.
func BearingDeg(lat1, lon1, lat2, lon2 float64) float64 {
	φ1 := degToRad(lat1)
	φ2 := degToRad(lat2)
	Δλ := degToRad(lon2 - lon1)
	y := math.Sin(Δλ) * math.Cos(φ2)
	x := math.Cos(φ1)*math.Sin(φ2) - math.Sin(φ1)*math.Cos(φ2)*math.Cos(Δλ)
	θ := math.Atan2(y, x)
	return math.Mod(θ*180.0/math.Pi+360.0, 360.0)
}

func degToRad(d float64) float64 {
	return d * math.Pi / 180.0
}
