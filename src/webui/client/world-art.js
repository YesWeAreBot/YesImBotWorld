/* Original vector identity: open horizons, branching paths and worlds still unfolding.
 * Standalone source previews live in src/webui/assets. All artwork is embedded in the
 * page; no image request or external font is needed. A unique prefix per instance
 * prevents gradients and accessible titles colliding when several views are mounted.
 */
var worldArt = (function () {
    var sequence = 0;
    function svg(name, box, body, options) {
        options = options || {};
        var id = 'world-art-' + name + '-' + (++sequence);
        var label = { logo: '无界世界：开放的边界与不断延伸的可能', hero: '一幅展开中的世界航图：不同地貌由开放的地平线连接，路径仍向远处生长', empty: '一颗等待生长的世界种子', orbit: '正在延伸的世界轨迹' }[name];
        var accessibility = options.decorative ? ' aria-hidden="true"' : ' role="img" aria-labelledby="' + id + '-title"';
        return '<svg xmlns="http://www.w3.org/2000/svg" class="world-art world-art-' + name + (name === 'hero' ? ' studio-hero-art' : name === 'logo' ? ' brand-mark' : '') + '" viewBox="' + box + '" fill="none"' + accessibility + '>' + (options.decorative ? '' : '<title id="' + id + '-title">' + label + '</title>') + body.replace(/@ID@/g, id) + '</svg>';
    }
    function logo(options) {
        return svg('logo', '0 0 48 48', `
          <path d="M34.5 8.8a18 18 0 1 0 6.6 21.5" stroke="#67d9c0" stroke-width="2.5" stroke-linecap="round"/>
          <path d="M10.8 31.3c5.2-.6 10.3-5.5 13.3-13.5M13.4 34c9.9-.2 17.6-6.3 25-16.9M18 37c9.6.3 16.7-2.9 24.1-10.1" stroke="#67d9c0" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="25.5" cy="12.8" r="3.2" fill="#f1c38b"/>
          <circle cx="41" cy="12.8" r="3.2" fill="#67d9c0"/>
          <circle cx="44" cy="24.3" r="2.4" fill="#a3aff5"/>
        `, options);
    }
    function hero(options) {
        return svg('hero', '0 0 640 340', `
          <defs>
            <linearGradient id="@ID@-horizon" x1="116" y1="236" x2="570" y2="178" gradientUnits="userSpaceOnUse"><stop stop-color="#67d9c0" stop-opacity="0"/><stop offset=".38" stop-color="#67d9c0" stop-opacity=".75"/><stop offset="1" stop-color="#8f9ee5" stop-opacity="0"/></linearGradient>
            <linearGradient id="@ID@-gate" x1="267" y1="64" x2="413" y2="207" gradientUnits="userSpaceOnUse"><stop stop-color="#c7fae9"/><stop offset=".52" stop-color="#67d9c0"/><stop offset="1" stop-color="#67d9c0" stop-opacity=".16"/></linearGradient>
            <linearGradient id="@ID@-terrain" x1="349" y1="183" x2="355" y2="296" gradientUnits="userSpaceOnUse"><stop stop-color="#286e69" stop-opacity=".66"/><stop offset="1" stop-color="#152d3a" stop-opacity=".15"/></linearGradient>
            <linearGradient id="@ID@-sand" x1="152" y1="168" x2="167" y2="227" gradientUnits="userSpaceOnUse"><stop stop-color="#e5b680" stop-opacity=".28"/><stop offset="1" stop-color="#e5b680" stop-opacity=".04"/></linearGradient>
            <linearGradient id="@ID@-future" x1="466" y1="133" x2="485" y2="206" gradientUnits="userSpaceOnUse"><stop stop-color="#8f9ee5" stop-opacity=".29"/><stop offset="1" stop-color="#8f9ee5" stop-opacity=".03"/></linearGradient>
          </defs>

          <!-- Open survey arcs extend beyond the scene: these are possibilities, not a boundary. -->
          <g stroke="#8ea8bb" stroke-opacity=".18" stroke-width=".8">
            <path d="M89 325C37 188 122 32 282 17c146-14 275 110 250 255"/>
            <path d="M178 330C64 230 93 72 217 35" stroke-dasharray="3 7"/>
            <path d="M354 18c157 14 251 149 231 284"/>
            <path d="M60 247c130-60 348-68 564-24M68 278c154-53 361-53 548-21"/>
          </g>
          <path d="M48 269c150-93 359-88 563-38" stroke="url(#@ID@-horizon)"/>
          <g stroke="#8ea8bb" stroke-opacity=".32" stroke-width=".8">
            <path d="M260 20v7m-3.5-3.5h7M533 295v7m-3.5-3.5h7M75 182v7m-3.5-3.5h7M582 101v7m-3.5-3.5h7"/>
            <path d="m93 99 5 2m10-30 4 3m362-14-3 4m57 40-4 2m53 77-5 1"/>
          </g>
          <g fill="#a8c1ce"><circle cx="222" cy="45" r="1.5"/><circle cx="559" cy="220" r="1.5"/><circle cx="99" cy="282" r="1.5"/><circle cx="545" cy="66" r="1"/><circle cx="390" cy="28" r="1"/><circle cx="53" cy="135" r="1"/></g>

          <!-- A warm, wind-cut archipelago. Each contour is drawn independently. -->
          <path d="M98 188c12-17 35-17 54-30 13-9 24-6 33 3 9 9 28 7 39 16 13 11 1 21-18 25-17 4-27 14-51 15-21 1-30-8-45-11-14-3-22-8-12-18Z" fill="url(#@ID@-sand)" stroke="#e9bd89" stroke-opacity=".48"/>
          <path d="M105 189c19 0 33-4 47-16 15-13 31-7 38 1 7 7 18 7 26 9M104 198c23 6 37 6 56-5 15-10 32-10 48-7M126 207c22 2 37-6 53-10 9-2 15-2 23-1" stroke="#e9bd89" stroke-opacity=".45" stroke-width=".9"/>
          <path d="M133 174c6-12 13-25 22-35 11 16 16 25 19 31" fill="#e5b680" fill-opacity=".12" stroke="#edc598" stroke-opacity=".75"/>
          <path d="m155 139 2 29m-8-9 5-8" stroke="#edc598" stroke-opacity=".37"/>
          <circle cx="190" cy="136" r="12" fill="#f1c38b" fill-opacity=".13"/>
          <circle cx="190" cy="136" r="7" fill="#f1c38b"/>
          <path d="M189 155v9m-52 54-8 11h-25" stroke="#e9bd89" stroke-opacity=".35" stroke-width=".8"/>

          <!-- The central world is a river delta with growing, branching life. -->
          <path d="M218 236c-1-17 34-19 52-31 22-14 39-8 61-19 19-10 38-4 56 5 19 10 52 4 68 21 14 15 9 27-15 34-27 7-39 20-76 25-29 5-49-7-77-5-31 1-68-13-69-30Z" fill="url(#@ID@-terrain)" stroke="#76d8c0" stroke-opacity=".46"/>
          <path d="M232 237c28-1 41-13 61-13 23 0 31-17 54-17 26-1 36 10 59 11 19 0 28 7 36 12M238 247c24-2 51 8 71 1 27-10 44-5 61-14 20-10 45-5 60-1M268 257c32 5 49-8 76-5 21 2 37-7 55-8M263 220c15 1 29-9 43-11 23-4 33-15 54-13 19 1 32 11 53 11" stroke="#75d6bf" stroke-opacity=".36" stroke-width=".85"/>
          <path d="M350 201c-1 17-28 17-24 29 2 10 39 9 32 24-4 9-16 12-24 14" stroke="#a3ecdc" stroke-opacity=".7" stroke-width="1.5"/>
          <path d="M358 244c13-4 16-14 36-18M328 228c-21-9-32-8-40-8" stroke="#a3ecdc" stroke-opacity=".48"/>
          <g stroke="#95dfc8" stroke-width="1.25" stroke-linecap="round">
            <path d="M280 216v-36m0 19c-11 0-17-8-17-14 10 0 17 5 17 14Zm0-10c1-13 9-19 18-20 0 10-7 19-18 20Z" fill="#4c9d85" fill-opacity=".32"/>
            <path d="M304 209v-22m0 11c-7-2-10-7-10-13 7 1 10 6 10 13Zm0-5c1-7 5-11 11-11-1 7-4 10-11 11Z" fill="#4c9d85" fill-opacity=".2" stroke-opacity=".6"/>
          </g>
          <g fill="#a3ecdc"><circle cx="280" cy="217" r="2"/><circle cx="405" cy="226" r="1.6"/><circle cx="315" cy="253" r="1.2"/></g>

          <!-- An unfinished gateway: no closed container, and several ways onward. -->
          <path d="M321 193c-26-29-28-67-5-97 24-31 66-39 90-15 13 12 17 28 13 45" stroke="#67d9c0" stroke-opacity=".09" stroke-width="19"/>
          <path d="M321 193c-26-29-28-67-5-97 24-31 66-39 90-15 13 12 17 28 13 45" stroke="url(#@ID@-gate)" stroke-width="4" stroke-linecap="round"/>
          <path d="M333 184c-22-25-21-56-3-80 21-27 53-32 72-12" stroke="#a3ecdc" stroke-opacity=".3" stroke-width=".8"/>
          <path d="M412 151c-8 20-23 35-42 43" stroke="#67d9c0" stroke-opacity=".68" stroke-width="4" stroke-linecap="round"/>
          <circle cx="419" cy="126" r="4.5" fill="#d4fff0"/>
          <circle cx="412" cy="151" r="3" fill="#67d9c0"/>
          <path d="M347 199c6-26 29-44 51-59 30-21 56-31 81-56" stroke="#67d9c0" stroke-opacity=".43" stroke-dasharray="2 5"/>
          <path d="M346 198c-32-15-61-28-108-32M370 194c37-16 66-19 107-21" stroke="#97c5c8" stroke-opacity=".35" stroke-width=".9" stroke-dasharray="2 5"/>
          <path d="M365 155c1-27 1-52-5-72" stroke="#b3e5d9" stroke-opacity=".3" stroke-width=".8" stroke-dasharray="2 5"/>

          <!-- A cool prismatic landscape: another possible kind of world. -->
          <path d="M433 179c11-14 27-13 43-23 11-7 28-4 38 5 8 7 26 8 31 20 4 9-10 19-27 21-21 2-35 10-56 6-17-4-44-9-29-29Z" fill="url(#@ID@-future)" stroke="#9faced" stroke-opacity=".55"/>
          <path d="m448 181 33-11 24 6 26 10-34 9-23-4-26-10Zm8 16 21 4 29-3" stroke="#a8b5f2" stroke-opacity=".37" stroke-width=".8"/>
          <path d="m471 180 1-45 15-24 14 28-1 42" fill="#899de9" fill-opacity=".1" stroke="#a8b5f2" stroke-opacity=".82"/>
          <path d="m472 135 15 6 14-2m-14-28v30l13 40m-13-40-16 39" stroke="#a8b5f2" stroke-opacity=".55" stroke-width=".8"/>
          <path d="m513 180 4-21 11-11 1 28" stroke="#8f9ee5" stroke-opacity=".42"/>
          <path d="m500 205 8 15h31" stroke="#a8b5f2" stroke-opacity=".35" stroke-width=".8"/>

          <!-- New seeds continue outside the already drawn terrain. -->
          <g><circle cx="479" cy="84" r="9" stroke="#f1c38b" stroke-opacity=".25"/><circle cx="479" cy="84" r="3" fill="#f1c38b"/><circle cx="360" cy="66" r="3" fill="#a3ecdc"/><circle cx="238" cy="166" r="2.5" fill="#f1c38b"/></g>
          <path d="m348 294 9 4 9-4m-9 4v11M126 85l9 3 5-8" stroke="#88bcb8" stroke-opacity=".35" stroke-width=".8"/>
          <g fill="#9bb2bf" fill-opacity=".68" font-family="ui-monospace, monospace" font-size="7" letter-spacing="1.6"><text x="74" y="242">01 / ORIGIN</text><text x="543" y="223">03 / BEYOND</text><text x="277" y="294">02 / BECOMING</text></g>
        `, options);
    }
    function empty(options) {
        return svg('empty', '0 0 96 80', `
          <path d="M17 58c11-7 48-12 66-1M9 65c19-9 56-8 78-2" stroke="currentColor" stroke-opacity=".22"/>
          <path d="M32 58C19 45 23 24 39 18c12-5 24 0 29 10M70 38c0 8-4 15-11 19" stroke="currentColor" stroke-opacity=".65" stroke-width="1.4" stroke-linecap="round"/>
          <path d="M42 58c-2-11 4-22 13-28M43 49c-7 0-13-5-14-11 8 0 14 5 14 11Zm0-7c2-9 8-14 16-14-1 7-8 14-16 14Z" stroke="currentColor" stroke-opacity=".75" stroke-width="1.3" stroke-linecap="round"/>
          <circle cx="72" cy="29" r="3" fill="currentColor" opacity=".8"/><circle cx="65" cy="16" r="1.5" fill="currentColor" opacity=".4"/><path d="M19 28v6m-3-3h6m55 15v6m-3-3h6" stroke="currentColor" stroke-opacity=".4"/>
        `, options);
    }
    function orbit(options) {
        return svg('orbit', '0 0 40 40', `
          <path d="M31 11A15 15 0 1 0 35 23" stroke="#67d9c0" stroke-opacity=".48" stroke-width="1.3" stroke-linecap="round"/>
          <path d="M8 25c8-1 14-8 18-15M10 29c13 0 21-5 28-14" stroke="#67d9c0" stroke-opacity=".65" stroke-width="1.3" stroke-linecap="round"/>
          <circle cx="28" cy="6" r="2.5" fill="#f1c38b"/><circle cx="36" cy="12" r="2.5" fill="#67d9c0"/>
        `, options);
    }
    return { logo: logo, hero: hero, empty: empty, orbit: orbit };
})();
