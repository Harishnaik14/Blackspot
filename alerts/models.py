from django.db import models


class Alert(models.Model):
    hazard = models.CharField(max_length=200)
    recommended_speed = models.FloatField()
    current_speed = models.FloatField()
    distance = models.FloatField()
    risk_level = models.CharField(max_length=20)
    timestamp = models.DateTimeField(auto_now_add=True)

# Create your models here.
