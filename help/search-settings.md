# Setting up your search

**Settings > Your search** tells the pipeline what to look for. **Build a draft** (under About you) fills it in from your resume; check it before you save.

## The fields

- **Job titles to search for:** one per line. Each title is a search on the job sources, so use the titles employers actually post: "VP Engineering" and "VP of Engineering" are both worth listing. Five to ten is plenty.
- **Words a relevant title contains:** a found job is kept only when its title has one of these. They catch variations the searches bring back ("engineering", "platform", "cto").
- **Words that rule a title out:** titles with these are dropped ("intern", "sales", "recruiter").
- **Where you can work in person:** cities and areas as "City, ST". Remote jobs are always included; on-site and hybrid jobs elsewhere are marked as a location mismatch.
- **Fractional or part-time titles:** only if you want that kind of work ("Fractional CTO"). These jobs score with fractional fit, pay, and hours.
- **Job sites to skip:** domains whose links you never want.

## Example: a VP of Engineering, remote or near home

```
Job titles:      VP Engineering / VP of Engineering / Head of Engineering /
                 SVP Engineering / Chief Technology Officer
Relevant words:  engineering / technology / cto / platform
Ruled out:       intern / sales / recruiter / manager of
Places:          Anytown, ST / Nearby City, ST
```

## Example: a product leader, fully remote

```
Job titles:      VP Product / Head of Product / Director of Product Management
Relevant words:  product
Ruled out:       marketing / owner / intern
Places:          (leave empty: remote only)
```

## Example: fractional finance work

```
Job titles:      Fractional CFO / Part-time CFO / Interim CFO
Relevant words:  cfo / finance
Fractional:      Fractional CFO / Part-time CFO
Places:          (leave empty: remote only)
```

## Tuning it

After a run or two, look at what landed in **Discovered** with low scores. If a whole kind of job keeps appearing, add a word that rules it out. If good jobs are missing, add the titles they use.
