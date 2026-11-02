// A steady tick for the video edit: a worker is not slowed down when its page is in the background
let timer = null;
onmessage = (e) => {
  if (timer) clearInterval(timer);
  timer = e.data ? setInterval(() => postMessage(0), e.data) : null;
};
