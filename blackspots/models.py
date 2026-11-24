from django.db import models


class Blackspot(models.Model):
    blackspot_id = models.CharField(max_length=60, blank=True)
    state = models.CharField(max_length=100, blank=True)
    district = models.CharField(max_length=100, blank=True)
    highway_number = models.CharField(max_length=50, blank=True)
    road_name = models.CharField(max_length=200, blank=True)
    latitude = models.FloatField()
    longitude = models.FloatField()
    road_chainage = models.CharField(max_length=100, blank=True)
    accident_count = models.PositiveIntegerField(null=True, blank=True)
    fatalities = models.PositiveIntegerField(null=True, blank=True)
    injuries = models.PositiveIntegerField(null=True, blank=True)
    accident_reporting_period = models.CharField(max_length=100, blank=True)
    severity = models.PositiveSmallIntegerField(default=1)
    rectification_status = models.CharField(max_length=100, blank=True)
    source = models.CharField(max_length=200)
    verification_status = models.CharField(max_length=30, default='illustrative')

# Create your models here.
