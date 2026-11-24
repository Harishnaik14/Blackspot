from rest_framework import serializers
from apps.vehicles.models import Vehicle
from apps.roads.models import RoadSegment
from apps.blackspots.models import Blackspot
from apps.gps_tracking.models import GPSRecord
from apps.curve_analysis.models import Curve
from apps.alerts.models import Alert


class VehicleSerializer(serializers.ModelSerializer):
    class Meta:
        model=Vehicle
        fields='__all__'


class RoadSegmentSerializer(serializers.ModelSerializer):
    class Meta:
        model=RoadSegment
        fields='__all__'


class BlackspotSerializer(serializers.ModelSerializer):
    class Meta:
        model=Blackspot
        fields='__all__'


class GPSRecordSerializer(serializers.ModelSerializer):
    class Meta:
        model=GPSRecord
        fields='__all__'


class CurveSerializer(serializers.ModelSerializer):
    class Meta:
        model=Curve
        fields='__all__'


class AlertSerializer(serializers.ModelSerializer):
    class Meta:
        model=Alert
        fields='__all__'
