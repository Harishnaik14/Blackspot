from django.test import SimpleTestCase, TestCase
from rest_framework.test import APIClient
from apps.curve_analysis.geometry import detect_curves
from apps.speed_prediction.engine import estimate_safe_speed, warning_distance


class APIValidationTests(TestCase):
    def setUp(self):
        self.client=APIClient()

    def test_blackspots_endpoint(self):
        response=self.client.get('/api/blackspots/')
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.data)
        self.assertEqual(response.data[0]['verification_status'],'illustrative')

    def test_safe_speed_endpoint(self):
        response=self.client.post('/api/safe-speed/',{'radius':62,'vehicle_type':'bike'},format='json')
        self.assertEqual(response.status_code,200)
        self.assertIn('recommended_speed_kph',response.data)

    def test_gps_validation(self):
        response=self.client.post('/api/gps/',{'latitude':300,'longitude':73},format='json')
        self.assertEqual(response.status_code,400)

    def test_curve_analysis_requires_points(self):
        response=self.client.post('/api/curve-analysis/',{'points':[]},format='json')
        self.assertEqual(response.status_code,400)

    def test_india_dataset_hairpins_are_hairpins_only(self):
        response=self.client.get('/api/dataset/hairpins/')
        self.assertEqual(response.status_code,200)
        for curve in response.data:
            self.assertEqual(curve["curve_type"],"hairpin")

    def test_official_accident_blackspot_dataset_starts_empty(self):
        response=self.client.get('/api/dataset/blackspots/')
        self.assertEqual(response.status_code,200)
        self.assertEqual(len(response.data),0)

    def test_straight_road_has_no_false_curve(self):
        points=[{"lat":18.7,"lon":73.4+i*0.001} for i in range(12)]
        self.assertEqual(detect_curves(points),[])

    def test_safe_speed_and_warning_distance_are_positive(self):
        self.assertGreater(estimate_safe_speed(62,'car'),0)
        self.assertGreater(warning_distance(60,24),0)
