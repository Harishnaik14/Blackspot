async function init(){
  let observations=[];
  try { observations=JSON.parse(localStorage.getItem('blackspotApproachObservations')||'[]'); } catch (_) {}
  const averageAccuracy = observations.length ? observations.reduce((sum,item)=>sum+item.accuracy,0)/observations.length : null;
  const accuracyLabel = averageAccuracy === null ? 'No approach observations' : `${averageAccuracy.toFixed(1)}% approach accuracy`;
  const options={
    responsive:true,
    maintainAspectRatio:false,
    plugins:{legend:{labels:{color:'#8fa1b3'}}},
    scales:{
      x:{ticks:{color:'#8fa1b3'},grid:{color:'rgba(255,255,255,.06)'}},
      y:{ticks:{color:'#8fa1b3'},grid:{color:'rgba(255,255,255,.06)'},beginAtZero:true},
    },
  };
  const recent=observations.slice(-20);
  document.getElementById('accuracySummary').textContent=observations.length
    ? `${accuracyLabel} across ${observations.length} recorded approach observations. Accuracy measures closeness to the recommended approach speed.`
    : 'No driver observations are recorded yet. Start the demo or enable GPS to calculate approach accuracy.';
  new Chart(document.getElementById('accuracyChart'),{
    type:'line',
    data:{
      labels:recent.map((item,index)=>`Reading ${index+1}`),
      datasets:[
        {label:'Actual speed km/h',data:recent.map(item=>item.actual),borderColor:'#b7c2ca',backgroundColor:'rgba(183,194,202,.12)',tension:.35},
        {label:'Recommended speed km/h',data:recent.map(item=>item.recommended),borderColor:'#70d8d1',backgroundColor:'rgba(112,216,209,.12)',tension:.35},
        {label:'Approach accuracy %',data:recent.map(item=>item.accuracy),borderColor:'#55d6a0',backgroundColor:'rgba(85,214,160,.12)',tension:.35,yAxisID:'accuracy'},
      ],
    },
    options:{
      ...options,
      scales:{
        ...options.scales,
        accuracy:{min:0,max:100,ticks:{color:'#55d6a0'},grid:{color:'rgba(85,214,160,.08)'},position:'right'},
      },
    },
  });
}
init();
