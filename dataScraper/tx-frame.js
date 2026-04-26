(function(){
  function validateIFrame(iframe){
      if(!iframe.hasAttribute("src")){
          return(false);
      }

      var src = iframe.getAttribute("src");
      if(src.indexOf("://") === -1 && src.indexOf(":\\\\") === -1){
          return(true);
      }

      if(src.indexOf(location.origin) === 0){
          return(true);
      }
      return(false);
  }
  window.SASGraphicsAccelerator_attendance=true;
  var iframes = document.querySelectorAll("iframe");
  for(var i=0; i<iframes.length; i++){
      if(validateIFrame(iframes[i])){
          try{
              iframes[i].contentWindow.SASGraphicsAccelerator_attendance=true;
          }catch(e){
          }
      }
  }
})()