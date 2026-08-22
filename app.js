const destinations = {
  beijing: "https://hoco-scy.github.io/beijing-opportunity-radar/",
  shanghai: "https://hoco-scy.github.io/shanghai-opportunity-radar/",
  guangzhou: "https://hoco-scy.github.io/guangzhou-opportunity-radar/",
  shenzhen: "https://hoco-scy.github.io/shenzhen-opportunity-radar/",
};

document.querySelector("#city-select").addEventListener("change", (event) => {
  const destination = destinations[event.target.value];
  if (destination) window.location.assign(destination);
});
