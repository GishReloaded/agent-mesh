const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.nav-links');
menu?.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') === 'true';
  menu.setAttribute('aria-expanded', String(!expanded));
  navigation?.classList.toggle('open', !expanded);
});
navigation?.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    menu?.setAttribute('aria-expanded', 'false');
    navigation.classList.remove('open');
  }
});
// A static client-side redirect needs no edge function or additional AWS service.
if (location.hostname === 'www.tandryx.com') {
  location.replace(`https://tandryx.com${location.pathname}${location.search}${location.hash}`);
}
