# Roads Less Traveled: county road files

Ready-made road lists for every US county, used by the Roads Less Traveled app so a phone can download its
county's roads in one quick file instead of asking the busy free map servers.

- One file per county: `https://github.com/ohioperformancesolutions/roadslesstraveled-roads/releases/download/roads-<state>/<county id>.json`
  (`<state>` like `missouri` or `new-york`; the county id is its OpenStreetMap relation id). Each release also has
  `counties.json`, a list of that state's counties.
- Built from Geofabrik's state extracts on the 2nd of each month by the **Build road files** workflow (it can
  also be run by hand from the Actions tab).
- Contains only public map data: road shapes and the county outline. No user data of any kind.

Road data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available under the
Open Database License (ODbL).
